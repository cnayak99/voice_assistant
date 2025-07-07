import { PermissionsAndroid, Platform } from 'react-native';
import { CONFIG } from '../config';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';

// Mobile audio recorder - Better for live streaming
let AudioRecord: any = null;
try {
  AudioRecord = require('react-native-audio-record').default;
} catch (e) {
  console.warn('react-native-audio-record not available');
}

// Enable playback in silence mode and through loudspeaker
Sound.setCategory('Playback', true); // true enables mixing with other audio
Sound.setMode('SpokenAudio'); // Optimized for speech

// AI Assistant class for real-time transcription
export class AIAssistant {
  private assemblyAIApiKey: string = CONFIG.ASSEMBLYAI_API_KEY;
  private groqApiKey: string = CONFIG.GROQ_API_KEY;
  private elevenlabsApiKey: string = CONFIG.ELEVENLABS_API_KEY;
  
  private transcriptionSocket: WebSocket | null = null;
  private lastConnectionAttempt: number = 0;
  private connectionCooldown: number = 5000; // 5 seconds cooldown
  
  // Platform-specific recording objects
  private isRecording: boolean = false; // Recording state
  private audioRecordInitialized: boolean = false; // AudioRecord initialization state
  
  private isTranscribing: boolean = false;
  private isManuallyStoppedByUser: boolean = false;
  private currentSound: any = null; // Track current playing sound for interruption
  private shouldCancelAudioGeneration: boolean = false; // Flag to cancel ongoing audio generation
  private isProcessingAIResponse: boolean = false; // Prevent concurrent AI response generation
  private shouldResumeTranscriptionAfterAudio: boolean = false; // Flag to resume transcription after audio
  private loggedFirstAudioChunk: boolean = false;
  private onTranscriptCallback: ((text: string, isFinal: boolean) => void) | null = null;
  private onAudioStateCallback: ((isPlaying: boolean) => void) | null = null;

  // Equivalent to self.transcriber = None
  private transcriber: any = null;

  // Equivalent to self.full_transcript with system prompt
  private fullTranscript: Array<{role: string, content: string}> = [
    {
      role: "system", 
      content: CONFIG.SYSTEM_PROMPT
    }
  ];

  // Audio buffering for AssemblyAI v3 requirements
  private audioBuffer: Uint8Array[] = [];
  private audioBufferSize: number = 0;
  private readonly targetChunkSize: number = 3200; // ~100ms at 16kHz, 16-bit, mono

  constructor(
    onTranscript?: (text: string, isFinal: boolean) => void,
    onAudioState?: (isPlaying: boolean) => void
  ) {
    this.onTranscriptCallback = onTranscript || null;
    this.onAudioStateCallback = onAudioState || null;
  }
  
  private async requestMicrophonePermission(): Promise<boolean> {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Audio Recording Permission',
            message: 'This app needs access to your microphone to record audio.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
      // For iOS, permissions are handled in Info.plist and runtime
      return true;
    } catch (error) {
      console.error('Error requesting microphone permission:', error);
      return false;
    }
  }
  private async getRealtimeToken(): Promise<string> {
    console.log('🔑 Fetching real-time token from AssemblyAI...');
    
    // AssemblyAI has migrated the real-time STT product to "Streaming" (v3).
    // Tokens are now obtained with a simple GET request to the new endpoint.
    // v3 token endpoint requires an expires_in_seconds query param (60–360000).
    const tokenQuery = new URLSearchParams({
      expires_in_seconds: '600',          // token TTL (60-360000 sec)
      max_session_duration_seconds: '600'
    }).toString();

    const res = await fetch(
      `https://streaming.assemblyai.com/v3/token?${tokenQuery}`,
      {
        method: 'GET',
        headers: {
          'authorization': this.assemblyAIApiKey
        }
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      console.error('❌ AssemblyAI token fetch failed:', res.status, errorText);
      throw new Error(`Failed to fetch real-time token from AssemblyAI: ${res.status} - ${errorText}`);
    }

    const data = await res.json();
    console.log('✅ Real-time token obtained successfully');
    return data.token;
  }
  // Step 2: Real-Time Transcription with AssemblyAI
  async startTranscription(): Promise<boolean> {
    try {
      console.log('🎤 Starting real-time transcription...');
      console.log('🔧 AudioRecord available:', !!AudioRecord);
      
      // Clear the manual stop flag when user manually starts transcription
      this.isManuallyStoppedByUser = false;
      this.shouldCancelAudioGeneration = false;
      
      // Check if we're in cooldown period
      const now = Date.now();
      if (now - this.lastConnectionAttempt < this.connectionCooldown) {
        const remainingCooldown = Math.ceil((this.connectionCooldown - (now - this.lastConnectionAttempt)) / 1000);
        console.log(`⏳ Connection cooldown active. Wait ${remainingCooldown} more seconds...`);
        return false;
      }
      
      // Ensure any existing connections are properly terminated first
      if (this.transcriptionSocket && this.transcriptionSocket.readyState !== WebSocket.CLOSED) {
        console.log('🧹 Properly terminating existing WebSocket connection...');
        
        // Send terminate message if connection is still open
        if (this.transcriptionSocket.readyState === WebSocket.OPEN) {
          try {
            this.transcriptionSocket.send(JSON.stringify({
              type: 'Terminate'
            }));
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            console.log('Could not send terminate message to existing session:', error);
          }
        }
        
        this.transcriptionSocket.close();
        this.transcriptionSocket = null;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      }
      
      this.lastConnectionAttempt = now;
      
      // Check microphone permission first
      const hasPermission = await this.requestMicrophonePermission();
      if (!hasPermission) {
        console.error('Microphone permission not granted');
        return false;
      }
      
      // Create WebSocket connection to AssemblyAI
      try {
        const token = await this.getRealtimeToken();
        // Updated WebSocket host for Streaming STT (v3)
        const websocketUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&format_turns=true&token=${token}`;
        console.log('🌐 Connecting to AssemblyAI WebSocket...');

        this.transcriptionSocket = new WebSocket(websocketUrl);
      } catch (tokenError) {
        console.error('❌ Failed to get real-time token:', tokenError);
        return false;
      }

      this.transcriptionSocket.onopen = () => {
        console.log('✅ AssemblyAI WebSocket connected');
        this.isTranscribing = true;
      };

      this.transcriptionSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('📨 WebSocket message:', data.type);
          this.onData(data);
        } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
        }
      };

      this.transcriptionSocket.onerror = (error) => {
        console.error('❌ AssemblyAI WebSocket error:', error);
        this.isTranscribing = false;
        this.onError(error);
      };

      this.transcriptionSocket.onclose = (event) => {
        console.log('🔌 AssemblyAI WebSocket closed:', event.code, event.reason);
        this.isTranscribing = false;
        
        // Handle specific error codes
        if (event.code === 4102) {
          console.log('⚠️ Stream limit exceeded - waiting before allowing retry...');
        } else if (event.code === 1006) {
          console.log('⚠️ WebSocket connection lost unexpectedly');
        } else if (event.code !== 1000) {
          console.log(`⚠️ WebSocket closed with unusual code: ${event.code}`);
        }
        
        // Ensure proper cleanup even on unexpected closure
        if (this.transcriptionSocket) {
          this.transcriptionSocket = null;
        }
        
        this.onClose();
      };

      // Start mobile recording
      return await this.startMobileRecording();
    } catch (error) {
      console.error('Error starting transcription:', error);
      this.onError(error);
      return false;
    }
  }

  // Mobile-specific recording with real-time streaming using AudioRecord
  private async startMobileRecording(): Promise<boolean> {
    try {
      console.log('Starting mobile recording with AudioRecord...');

      if (!AudioRecord) {
        console.error('AudioRecord not available');
        return false;
      }

      // Configure AudioRecord options for real-time streaming
      const options = {
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6, // VOICE_RECOGNITION for better speech quality
        wavFile: 'temp.wav' // Temporary file for processing
      };

      // Initialize AudioRecord
      AudioRecord.init(options);
      this.audioRecordInitialized = true;

      // Set up real-time data callback with buffering
      AudioRecord.on('data', (data: string) => {
        // This callback provides real-time base64 audio data chunks
        if (data && this.transcriptionSocket?.readyState === WebSocket.OPEN) {
          try {
            // Convert base64 to binary data (React Native compatible)
            const binaryString = atob(data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            
            // Add to buffer
            this.audioBuffer.push(bytes);
            this.audioBufferSize += bytes.length;
            
            // Send when buffer reaches target size (~100ms of audio)
            if (this.audioBufferSize >= this.targetChunkSize) {
              this.sendBufferedAudio();
            }
          } catch (error) {
            console.error('Error processing audio data:', error);
          }
        }
      });

      // Start recording
      AudioRecord.start();
      this.isRecording = true;

      console.log('Mobile recording started with live streaming using AudioRecord');
      return true;
    } catch (error) {
      console.error('Error starting mobile recording:', error);
      return false;
    }
  }

  // Stop transcription manually by user (sets manual stop flag)
  async stopTranscription(): Promise<void> {
    try {
      console.log('Stopping transcription...');
      console.log('🛑 User manually stopped transcription');
      this.isTranscribing = false;
      this.isManuallyStoppedByUser = true;
      
      // Immediately stop any currently playing audio and cancel audio generation
      this.stopCurrentAudio();
      this.shouldCancelAudioGeneration = true;
      
      await this.performStopTranscription();
    } catch (error) {
      console.error('Error stopping transcription:', error);
    }
  }

  // Stop transcription for processing (does NOT set manual stop flag)
  async stopTranscriptionForProcessing(): Promise<void> {
    try {
      console.log('🔄 Stopping transcription for AI processing...');
      this.isTranscribing = false;
      // Do NOT set isManuallyStoppedByUser = true here!
      
      await this.performStopTranscription();
    } catch (error) {
      console.error('Error stopping transcription for processing:', error);
    }
  }

  // Common transcription stopping logic
  private async performStopTranscription(): Promise<void> {
    try {
      // Stop AudioRecord recording first
      if (this.isRecording && AudioRecord) {
        try {
          AudioRecord.stop();
          this.isRecording = false;
          console.log('AudioRecord recording stopped');
        } catch (error) {
          console.error('Error stopping AudioRecord:', error);
        }
      }

      // Clean up AudioRecord if initialized
      if (this.audioRecordInitialized && AudioRecord) {
        try {
          // Remove all event listeners to prevent memory leaks
          if (AudioRecord.off) {
            AudioRecord.off('data');
          }
          if (AudioRecord.removeAllListeners) {
            AudioRecord.removeAllListeners();
          }
          this.audioRecordInitialized = false;
          console.log('AudioRecord cleaned up');
        } catch (error) {
          console.error('Error cleaning up AudioRecord:', error);
        }
      }

      // Send any remaining buffered audio before terminating
      if (this.audioBuffer.length > 0) {
        console.log('📤 Sending remaining buffered audio before termination...');
        this.sendBufferedAudio();
        await new Promise(resolve => setTimeout(resolve, 100)); // Brief wait
      }
      
      // Properly terminate AssemblyAI session
      if (this.transcriptionSocket && this.transcriptionSocket.readyState === WebSocket.OPEN) {
        try {
          console.log('📤 Sending terminate_session message to AssemblyAI...');
          this.transcriptionSocket.send(JSON.stringify({
            type: 'Terminate'
          }));
          
          // Wait a bit for the termination message to be processed
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Error sending terminate_session:', error);
        }
      }

      // Close WebSocket connection with proper cleanup
      if (this.transcriptionSocket) {
        try {
          // Remove event listeners to prevent memory leaks
          this.transcriptionSocket.onopen = null;
          this.transcriptionSocket.onmessage = null;
          this.transcriptionSocket.onerror = null;
          this.transcriptionSocket.onclose = null;
          
          // Close the connection
          if (this.transcriptionSocket.readyState === WebSocket.OPEN || 
              this.transcriptionSocket.readyState === WebSocket.CONNECTING) {
            this.transcriptionSocket.close(1000, 'Normal closure');
          }
          
          this.transcriptionSocket = null;
          console.log('WebSocket connection closed properly with cleanup');
        } catch (error) {
          console.error('Error closing WebSocket:', error);
          // Force cleanup even if close fails
          this.transcriptionSocket = null;
        }
      }

      console.log('Transcription stopped completely');
    } catch (error) {
      console.error('Error stopping transcription:', error);
    }
  }

  private onOpen(sessionId: string): void {
    console.log('Transcription session opened:', sessionId);
  }

  private onData(transcript: any): void {
    if (transcript.type === 'Turn' && !transcript.end_of_turn) {
      // Partial transcript - update UI
      this.onTranscriptCallback?.(transcript.transcript, false);
    } else if (transcript.type === 'Turn' && transcript.end_of_turn && transcript.turn_is_formatted) {
      // Final formatted transcript - process for AI response
      console.log(`Final transcript received: "${transcript.transcript}"`);
      this.onTranscriptCallback?.(transcript.transcript, true);
      
      this.fullTranscript.push({
        role: "user",
        content: transcript.transcript
      });
      
      // Generate AI response when we get a final transcript (only if not already processing)
      if (!this.isProcessingAIResponse) {
        console.log('Calling generateAIResponse with final transcript');
        this.generateAIResponse(transcript.transcript);
      } else {
        console.log('⚠️ Skipping AI response - already processing another response');
      }
    } else if (transcript.type === 'Termination') {
      console.log('✅ AssemblyAI session properly terminated');
    } else {
      console.log('📨 AssemblyAI message:', transcript.type, transcript);
    }
  }

  private onError(error: any): void {
    console.error('Transcription error:', error);
  }

  private onClose(): void {
    console.log('Transcription session closed');
  }

  getIsTranscribing(): boolean {
    return this.isTranscribing;
  }

  // Method to interrupt AI and start listening immediately
  async interruptAndListen(): Promise<boolean> {
    console.log('🚫 User interrupted AI - stopping audio and starting transcription...');
    
    // Stop any currently playing audio
    this.stopCurrentAudio();
    this.shouldCancelAudioGeneration = true;
    
    // Clear the resume flag since we're manually restarting
    this.shouldResumeTranscriptionAfterAudio = false;
    
    // Start transcription immediately
    const success = await this.startTranscription();
    if (success) {
      console.log('🎤 Transcription restarted after interruption');
    }
    
    return success;
  }

  // Step 3: Pass real-time transcript to Groq AI
  async generateAIResponse(transcriptText: string): Promise<void> {
    try {
      // Set processing flag to prevent concurrent responses
      this.isProcessingAIResponse = true;
      
      // Stop transcription while generating response (but not by user)
      await this.stopTranscriptionForProcessing();

      console.log(`\nUser: ${transcriptText}`);
      console.log('Preparing to call Groq API...');

      // Log the messages being sent to Groq
      console.log('Sending to Groq:', JSON.stringify(this.fullTranscript));
      
      try {
        // Generate response using Groq API directly with fetch
        console.log(`Calling Groq API with model: ${CONFIG.DEFAULT_MODEL}`);
        console.log(`Groq API Key (first 10 chars): ${this.groqApiKey.substring(0, 10)}...`);
        
        const requestBody = {
          model: CONFIG.DEFAULT_MODEL,
          messages: this.fullTranscript,
          temperature: CONFIG.TEMPERATURE,
          max_tokens: CONFIG.MAX_TOKENS
        };
        
        console.log('Request body:', JSON.stringify(requestBody, null, 2));
        
        const response = await fetch(CONFIG.GROQ_API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });
        
        console.log(`Response status: ${response.status} ${response.statusText}`);
        
        const responseText = await response.text();
        console.log('Groq API raw response:', responseText);
        
        let responseData;
        try {
          responseData = JSON.parse(responseText);
          console.log('Groq API response received:', JSON.stringify(responseData));
        } catch (parseError) {
          console.error('Failed to parse Groq API response as JSON:', parseError);
          console.error('Raw response text:', responseText);
          throw new Error(`Invalid JSON response from Groq API: ${responseText.substring(0, 200)}...`);
        }
        
        if (!response.ok) {
          console.error(`Groq API HTTP error: ${response.status} ${response.statusText}`);
          console.error('Response headers:', JSON.stringify([...response.headers.entries()]));
          throw new Error(`Groq API error: ${response.status} ${response.statusText} - ${responseText.substring(0, 200)}...`);
        }

        const aiResponse = responseData.choices[0].message.content;
        
        // Add assistant response to transcript history
        this.fullTranscript.push({
          role: "assistant",
          content: aiResponse
        });

        // Log the AI response
        console.log(`\nAI Assistant: ${aiResponse}`);
        
        // Generate audio from the response
        // Set flag to resume transcription after audio (since we just stopped it for processing)
        this.shouldResumeTranscriptionAfterAudio = true;
        await this.generateAudio(aiResponse);
      } catch (error: any) {
        console.error('Error calling Groq API:', error);
        if (error.response && error.response.data) {
          console.error('Groq API error details:', error.response.data);
        }
      }
      
            // Transcription will be automatically resumed after audio playback completes
      // This prevents conversation loops where AI responds to its own audio
      console.log('🎵 Audio generation completed - transcription will resume after playback...');
    } catch (error) {
      console.error('Error generating AI response:', error);
      // On error, manually restart transcription since no audio will be played
      if (!this.isManuallyStoppedByUser) {
        console.log('🔄 Error case - restarting transcription (no audio to play)...');
        await this.startTranscription();
      } else {
        console.log('❌ Error case - Not restarting - user has manually stopped');
      }
    } finally {
      // Always clear the processing flag when done
      this.isProcessingAIResponse = false;
    }
  }
  
  // Step 4: Generate audio with ElevenLabs
  async generateAudio(text: string): Promise<void> {
    try {
      // Check if audio generation should be cancelled (user pressed stop)
      if (this.shouldCancelAudioGeneration) {
        console.log('🚫 Audio generation cancelled - user stopped conversation');
        return;
      }
      
      console.log(`\nGenerating audio for: "${text}"`);
      
      // Prepare request for ElevenLabs API
      const voiceId = CONFIG.ELEVENLABS_VOICE_ID; // Rachel voice
      const url = `${CONFIG.ELEVENLABS_API_ENDPOINT}/${voiceId}/stream`;
      
      const requestBody = {
        text: text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      };
      
      console.log('Calling ElevenLabs API...');
      
      // Make the API call to ElevenLabs
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.elevenlabsApiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      }
      
      console.log('Audio stream received from ElevenLabs');
      
      // Check again if audio generation should be cancelled
      if (this.shouldCancelAudioGeneration) {
        console.log('🚫 Audio processing cancelled - user stopped conversation');
        return;
      }
      
      // For React Native, we need to use a different approach
      // Instead of using FileReader, we'll use direct Base64 encoding
      
      // Get the audio data as a blob
      const audioBlob = await response.blob();
      
      // Convert blob to base64 string
      const fileReaderInstance = new FileReader();
      fileReaderInstance.readAsDataURL(audioBlob);
      
              fileReaderInstance.onload = async () => {
          try {
            // Final check before playing audio
            if (this.shouldCancelAudioGeneration) {
              console.log('🚫 Audio playback cancelled - user stopped conversation');
              return;
            }
            
            const base64data = fileReaderInstance.result as string;
            // Remove the data URL prefix (e.g., "data:audio/mpeg;base64,")
            const base64Audio = base64data.split(',')[1];
            
            // Create a temporary file path
            const tempDir = RNFS.CachesDirectoryPath;
            const tempFilePath = `${tempDir}/temp_audio_${Date.now()}.mp3`;
            
            console.log('Writing audio to file:', tempFilePath);
            
            // Write the file
            await RNFS.writeFile(tempFilePath, base64Audio, 'base64');
            console.log('Audio file created:', tempFilePath);
            
            // Play the audio (only if not cancelled)
            if (!this.shouldCancelAudioGeneration) {
              await this.playAudioFile(tempFilePath);
            } else {
              console.log('🚫 Audio file created but playback cancelled');
              this.cleanupAudioFile(tempFilePath);
            }
          
        } catch (error) {
          console.error('Error processing audio:', error);
        }
      };
      
      fileReaderInstance.onerror = (error) => {
        console.error('Error reading audio data:', error);
      };
      
    } catch (error) {
      console.error('Error generating audio:', error);
    }
  }
  
  // Helper method to play audio file through loudspeaker
  private async playAudioFile(filePath: string): Promise<void> {
    try {
      console.log('🔊 Playing audio through loudspeaker:', filePath);
      
      // Check if file exists first
      const fileExists = await RNFS.exists(filePath);
      if (!fileExists) {
        console.error('Audio file does not exist:', filePath);
        return;
      }
      
      const fileStats = await RNFS.stat(filePath);
      console.log('Audio file size:', fileStats.size, 'bytes');
      
      // Transcription is already paused for AI processing at this point
      console.log(`🔍 Debug: shouldResumeTranscriptionAfterAudio = ${this.shouldResumeTranscriptionAfterAudio}`);
      
      // Create Sound instance - using absolute path
      const sound = new Sound(filePath, undefined, (error) => {
        if (error) {
          console.error('Failed to load the sound:', error);
          this.cleanupAudioFile(filePath);
          // Resume transcription if it was paused and no manual stop
          if (this.shouldResumeTranscriptionAfterAudio && !this.isManuallyStoppedByUser) {
            console.log('🔄 Resuming transcription after audio error...');
            this.shouldResumeTranscriptionAfterAudio = false;
            this.startTranscription();
          }
          return;
        }
        
        console.log('✅ Audio loaded successfully');
        console.log(`🎵 Duration: ${sound.getDuration().toFixed(2)} seconds`);
        
        // Track current sound for potential interruption
        this.currentSound = sound;
        
        // Notify UI that AI audio is starting
        if (this.onAudioStateCallback) {
          this.onAudioStateCallback(true);
        }
        
        // Set volume to maximum for loudspeaker playback
        sound.setVolume(1.0);
        
        // Play the sound through loudspeaker
        sound.play((success) => {
          if (success) {
            console.log('🎵 Audio playback completed successfully');
          } else {
            console.log('❌ Audio playback failed');
          }
          
          // Clear current sound reference
          this.currentSound = null;
          
          // Notify UI that AI audio has stopped
          if (this.onAudioStateCallback) {
            this.onAudioStateCallback(false);
          }
          
          // Release the audio player resource
          sound.release();
          
          // Clean up the temporary file
          this.cleanupAudioFile(filePath);
          
          // RESUME TRANSCRIPTION AFTER AI AUDIO PLAYBACK COMPLETES
          console.log(`🔍 Debug: shouldResumeTranscriptionAfterAudio = ${this.shouldResumeTranscriptionAfterAudio}`);
          console.log(`🔍 Debug: isManuallyStoppedByUser = ${this.isManuallyStoppedByUser}`);
          if (this.shouldResumeTranscriptionAfterAudio && !this.isManuallyStoppedByUser) {
            console.log('▶️ Resuming transcription after AI audio playback...');
            this.shouldResumeTranscriptionAfterAudio = false;
            // Small delay to ensure audio hardware is ready
            setTimeout(() => {
              this.startTranscription();
            }, 100);
          } else {
            console.log('🔍 Debug: Not resuming transcription - conditions not met');
          }
        });
      });
      
    } catch (error) {
      console.error('Error playing audio:', error);
      this.cleanupAudioFile(filePath);
    }
  }
  
  // Helper method to stop currently playing audio
  private stopCurrentAudio(): void {
    if (this.currentSound) {
      console.log('🔇 Stopping current audio playback');
      try {
        this.currentSound.stop(() => {
          console.log('✅ Audio stopped successfully');
          this.currentSound.release();
          this.currentSound = null;
          
          // Notify UI that AI audio has stopped
          if (this.onAudioStateCallback) {
            this.onAudioStateCallback(false);
          }
        });
      } catch (error) {
        console.error('Error stopping audio:', error);
        // Force cleanup even if stop fails
        try {
          this.currentSound.release();
        } catch (releaseError) {
          console.error('Error releasing audio:', releaseError);
        }
        this.currentSound = null;
        
        // Notify UI that AI audio has stopped even on error
        if (this.onAudioStateCallback) {
          this.onAudioStateCallback(false);
        }
      }
    }
  }

  // Helper method to clean up temporary audio files
  private cleanupAudioFile(filePath: string): void {
    RNFS.unlink(filePath)
      .then(() => console.log('Temporary audio file deleted'))
      .catch((err) => console.error('Error deleting temporary file:', err));
  }

  // Helper method to send buffered audio data
  private sendBufferedAudio(): void {
    if (this.audioBuffer.length === 0) return;
    
    try {
      // Combine all buffered chunks into one large array
      const totalSize = this.audioBufferSize;
      const combinedBytes = new Uint8Array(totalSize);
      let offset = 0;
      
      for (const chunk of this.audioBuffer) {
        combinedBytes.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Log first chunk for debugging
      if (!this.loggedFirstAudioChunk) {
        console.log('🔍 First buffered audio chunk (24 bytes):', Array.from(combinedBytes.slice(0, 24)));
        console.log('📊 Buffer stats:', this.audioBuffer.length, 'chunks,', totalSize, 'bytes total');
        this.loggedFirstAudioChunk = true;
      }
      
      // Send the combined audio data
      this.transcriptionSocket?.send(combinedBytes);
      console.log('Sent buffered audio chunk to AssemblyAI:', totalSize, 'bytes');
      
      // Clear the buffer
      this.audioBuffer = [];
      this.audioBufferSize = 0;
      
    } catch (error) {
      console.error('Error sending buffered audio:', error);
    }
  }

  // Comprehensive cleanup method for app shutdown or component unmount
  async cleanup(): Promise<void> {
    console.log('🧹 Starting comprehensive AI Assistant cleanup...');
    
    try {
      // Set manual stop flag to prevent any automatic restarts
      this.isManuallyStoppedByUser = true;
      this.shouldCancelAudioGeneration = true;
      this.shouldResumeTranscriptionAfterAudio = false;
      
      // Stop any playing audio immediately
      this.stopCurrentAudio();
      
      // Stop transcription with all cleanup
      await this.performStopTranscription();
      
      // Clear transcript history
      this.fullTranscript = [
        {
          role: "system", 
          content: CONFIG.SYSTEM_PROMPT
        }
      ];
      
      // Reset all flags
      this.isTranscribing = false;
      this.isRecording = false;
      this.isProcessingAIResponse = false;
      
      console.log('✅ AI Assistant cleanup completed');
    } catch (error) {
      console.error('❌ Error during AI Assistant cleanup:', error);
    }
  }
}
