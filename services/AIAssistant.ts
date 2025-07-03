import { PermissionsAndroid, Platform } from 'react-native';
import { CONFIG } from '../config';

// Mobile audio recorder - Better for live streaming
let AudioRecord: any = null;
try {
  AudioRecord = require('react-native-audio-record').default;
} catch (e) {
  console.warn('react-native-audio-record not available');
}

// AI Assistant class for real-time transcription
export class AIAssistant {
  private assemblyAIApiKey: string = CONFIG.ASSEMBLYAI_API_KEY;
  private groqApiKey: string = CONFIG.GROQ_API_KEY;
  
  private transcriptionSocket: WebSocket | null = null;
  private lastConnectionAttempt: number = 0;
  private connectionCooldown: number = 5000; // 5 seconds cooldown
  
  // Platform-specific recording objects
  private isRecording: boolean = false; // Recording state
  private audioRecordInitialized: boolean = false; // AudioRecord initialization state
  
  private isTranscribing: boolean = false;
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

  // Check and request microphone permission
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

  async stopTranscription(): Promise<void> {
    try {
      console.log('Stopping transcription...');
      this.isTranscribing = false;

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
      
      // Generate AI response when we get a final transcript
      console.log('Calling generateAIResponse with final transcript');
      this.generateAIResponse(transcript.text);
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
      // Stop transcription while generating response
      await this.stopTranscription();

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
      } catch (error: any) {
        console.error('Error calling Groq API:', error);
        if (error.response && error.response.data) {
          console.error('Groq API error details:', error.response.data);
        }
      }
      
      // Restart transcription
      await this.startTranscription();
      console.log("\nReal-time transcription: ");
    } catch (error) {
      console.error('Error generating AI response:', error);
      // Restart transcription even if there was an error
      await this.startTranscription();
    }
  }
}
