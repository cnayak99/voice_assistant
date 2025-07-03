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
  private onTranscriptCallback: ((text: string, isFinal: boolean) => void) | null = null;

  // Equivalent to self.transcriber = None
  private transcriber: any = null;

  // Equivalent to self.full_transcript with system prompt
  private fullTranscript: Array<{role: string, content: string}> = [
    {
      role: "system", 
      content: CONFIG.SYSTEM_PROMPT
    }
  ];

  constructor(onTranscript?: (text: string, isFinal: boolean) => void) {
    this.onTranscriptCallback = onTranscript || null;
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
    
    const res = await fetch('https://api.assemblyai.com/v2/realtime/token', {
      method: 'POST',
      headers: {
        'authorization': this.assemblyAIApiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        expires_in: 3600 // Token expires in 1 hour (3600 seconds)
      })
    });

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
              terminate_session: true
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
        const websocketUrl = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`;
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
          console.log('📨 WebSocket message:', data.message_type);
          this.onData(data);
        } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
        }
      };

      this.transcriptionSocket.onerror = (error) => {
        console.error('❌ AssemblyAI WebSocket error:', error);
        this.onError(error);
      };

      this.transcriptionSocket.onclose = (event) => {
        console.log('🔌 AssemblyAI WebSocket closed:', event.code, event.reason);
        this.isTranscribing = false;
        
        // Handle specific error codes
        if (event.code === 4102) {
          console.log('⚠️ Stream limit exceeded - waiting before allowing retry...');
          // You could add a delay here before allowing new connections
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

      // Set up real-time data callback
      AudioRecord.on('data', (data: string) => {
        // This callback provides real-time base64 audio data chunks
        if (data && this.transcriptionSocket?.readyState === WebSocket.OPEN) {
          try {
            // Send audio data directly to AssemblyAI WebSocket
            this.transcriptionSocket.send(JSON.stringify({
              audio_data: data
            }));
            console.log('Sent audio chunk to AssemblyAI:', data.length, 'characters');
          } catch (error) {
            console.error('Error sending audio data:', error);
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
          // Remove data event listener specifically
          if (AudioRecord.off) {
            AudioRecord.off('data');
          }
          this.audioRecordInitialized = false;
          console.log('AudioRecord cleaned up');
        } catch (error) {
          console.error('Error cleaning up AudioRecord:', error);
        }
      }

      // Properly terminate AssemblyAI session
      if (this.transcriptionSocket && this.transcriptionSocket.readyState === WebSocket.OPEN) {
        try {
          console.log('📤 Sending terminate_session message to AssemblyAI...');
          this.transcriptionSocket.send(JSON.stringify({
            terminate_session: true
          }));
          
          // Wait a bit for the termination message to be processed
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Error sending terminate_session:', error);
        }
      }

      // Close WebSocket connection
      if (this.transcriptionSocket) {
        this.transcriptionSocket.close();
        this.transcriptionSocket = null;
        console.log('WebSocket connection closed properly');
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
    if (transcript.message_type === 'PartialTranscript') {
      this.onTranscriptCallback?.(transcript.text, false);
    } else if (transcript.message_type === 'FinalTranscript') {
      console.log(`Final transcript received: "${transcript.text}"`);
      this.onTranscriptCallback?.(transcript.text, true);
      
      this.fullTranscript.push({
        role: "user",
        content: transcript.text
      });
      
      // Generate AI response when we get a final transcript (only if not already processing)
      if (!this.isProcessingAIResponse) {
        console.log('Calling generateAIResponse with final transcript');
        this.generateAIResponse(transcript.text);
      } else {
        console.log('⚠️ Skipping AI response - already processing another response');
      }
    } else if (transcript.message_type === 'SessionTerminated') {
      console.log('✅ AssemblyAI session properly terminated');
    } else {
      console.log('📨 AssemblyAI message:', transcript.message_type, transcript);
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
        
        const requestBody = {
          model: CONFIG.DEFAULT_MODEL,
          messages: this.fullTranscript,
          temperature: CONFIG.TEMPERATURE,
          max_tokens: CONFIG.MAX_TOKENS
        };
        
        const response = await fetch(CONFIG.GROQ_API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });
        
        const responseData = await response.json();
        console.log('Groq API response received:', JSON.stringify(responseData));
        
        if (!response.ok) {
          throw new Error(`Groq API error: ${response.status} - ${JSON.stringify(responseData)}`);
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
            }, 500);
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
      }
    }
  }

  // Helper method to clean up temporary audio files
  private cleanupAudioFile(filePath: string): void {
    RNFS.unlink(filePath)
      .then(() => console.log('Temporary audio file deleted'))
      .catch((err) => console.error('Error deleting temporary file:', err));
  }
}
