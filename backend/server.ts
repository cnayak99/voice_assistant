import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { AssemblyAI } from 'assemblyai';
import Groq from 'groq-sdk';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Check if AssemblyAI API key is set
if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error('❌ ASSEMBLYAI_API_KEY is not set in .env file');
  console.log('Please get your API key from https://www.assemblyai.com/');
  process.exit(1);
}

// Check if Groq API key is set
if (!process.env.GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY is not set in .env file');
  console.log('Please get your API key from https://console.groq.com/');
  process.exit(1);
}

// Check if Google credentials are set
if (!process.env.GOOGLE_TTS_API_KEY) {
  console.error('❌ GOOGLE_TTS_API_KEY is not set in .env file');
  console.log('Please get your API key from Google Cloud Console');
  process.exit(1);
}

// Initialize AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY
});

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Initialize Google TTS client with API key
const ttsClient = new TextToSpeechClient({
  apiKey: process.env.GOOGLE_TTS_API_KEY
});

console.log('✅ AssemblyAI client initialized');
console.log('✅ Groq client initialized');
console.log('✅ Google TTS client initialized');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Store connected clients
const clients = new Set<WebSocket>();

// Create audio directory if it doesn't exist
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// Function to transcribe audio using AssemblyAI
async function transcribeAudio(filepath: string): Promise<string> {
  try {
    const stats = fs.statSync(filepath);
    console.log('[DEBUG] Audio file size:', stats.size, 'bytes');
    console.log('[DEBUG] Sending audio file to AssemblyAI...');

    const start = Date.now();
    
    // Upload and transcribe the audio file
    const transcript = await client.transcripts.transcribe({
      audio: filepath,
      speech_model: 'best' // Use the best quality model
    });

    console.log('[DEBUG] AssemblyAI returned in', Date.now() - start, 'ms');
    
    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }
    
    return transcript.text || 'No speech detected';
  } catch (error: any) {
    console.error('[ERROR] AssemblyAI transcription error:', error.message);
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}

// Function to process transcribed text with Groq LLM
async function processWithGroq(transcribedText: string): Promise<string> {
  try {
    console.log('[DEBUG] Sending text to Groq LLM:', transcribedText);
    
    const start = Date.now();
    
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system", 
          content: "You are a helpful voice assistant. Provide clear, concise, and friendly responses to user queries."
        },
        {
          role: "user",
          content: transcribedText
        }
      ],
      model: "llama3-8b-8192", // Updated to a supported model
      temperature: 0.7,
      max_tokens: 150 // Keep responses concise for voice
    });

    const response = chatCompletion.choices[0]?.message?.content || 'I apologize, but I could not generate a response.';
    
    console.log('[DEBUG] Groq returned in', Date.now() - start, 'ms');
    console.log('[DEBUG] Groq response:', response);
    
    return response;
  } catch (error: any) {
    console.error('[ERROR] Groq LLM error:', error.message);
    throw new Error(`Failed to process with Groq: ${error.message}`);
  }
}

// Function to convert text to speech using Google TTS
async function convertTextToSpeech(text: string): Promise<string> {
  try {
    console.log('[DEBUG] Converting text to speech:', text);
    
    const start = Date.now();
    
    const request = {
      input: { text: text },
      voice: {
        languageCode: 'en-US',
        name: 'en-US-Standard-D', // Male voice
        ssmlGender: 'MALE' as const
      },
      audioConfig: {
        audioEncoding: 'MP3' as const,
        speakingRate: 1.0,
        pitch: 0.0,
        volumeGainDb: 0.0
      }
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    
    if (!response.audioContent) {
      throw new Error('No audio content received from Google TTS');
    }
    
    // Convert audio to base64 for transmission
    const audioBase64 = Buffer.from(response.audioContent).toString('base64');
    
    console.log('[DEBUG] Google TTS returned in', Date.now() - start, 'ms');
    console.log('[DEBUG] Audio size:', audioBase64.length, 'characters');
    
    return audioBase64;
  } catch (error: any) {
    console.error('[ERROR] Google TTS error:', error.message);
    throw new Error(`Failed to convert text to speech: ${error.message}`);
  }
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket) => {
  console.log('New WebSocket connection established');

  clients.add(ws);

  ws.on('message', async (message: string | Buffer) => {
    try {
      console.log('[DEBUG] Received message type:', typeof message);
      console.log('[DEBUG] Message instanceof Buffer:', message instanceof Buffer);
      console.log('[DEBUG] Message length:', message.length);
      
      // Check if message is binary (audio data) or text
      if (message instanceof Buffer) {
        // Handle binary audio data - just log it for now
        console.log('[DEBUG] Received binary audio data, size:', message.length, 'bytes');
        console.log('[DEBUG] First 50 bytes as string:', message.toString('utf8', 0, 50));
        
        // Try to parse as JSON in case it's actually text sent as buffer
        try {
          const jsonData = JSON.parse(message.toString('utf8'));
          console.log('[DEBUG] Successfully parsed buffer as JSON:', jsonData.type);
          // Process as JSON message
          await handleJsonMessage(ws, jsonData);
        } catch (parseError) {
          console.log('[DEBUG] Buffer is not valid JSON, treating as raw binary data');
        }
      } else {
        // Handle text messages
        console.log('[DEBUG] Received text message, first 100 chars:', message.toString().substring(0, 100));
        const data = JSON.parse(message.toString());
        console.log('[DEBUG] Parsed message type:', data.type);
        await handleJsonMessage(ws, data);
      }
    } catch (error: any) {
      console.error('[ERROR] Error processing message:', error);
    }
  });

  // Helper function to handle JSON messages
  async function handleJsonMessage(ws: WebSocket, data: any) {
    console.log('[DEBUG] Handling JSON message type:', data.type);

    // Handle different message types
    switch (data.type) {
      case 'voice_start':
        console.log('Voice listening started');
        ws.send(JSON.stringify({
          type: 'voice_start_ack',
          message: 'Voice listening started'
        }));
        break;

      case 'voice_stop':
        console.log('Voice listening stopped');
        ws.send(JSON.stringify({
          type: 'voice_stop_ack',
          message: 'Voice listening stopped'
        }));
        break;

      case 'audio_complete':
        console.log('🎤 Voice received!');
        console.log(`Duration: ${data.duration}ms`);
        console.log(`Format: ${data.format}`);
        console.log(`Sample Rate: ${data.sampleRate}Hz`);
        console.log(`Channels: ${data.channels}`);
        console.log(`Audio data present: ${!!data.audioData}`);
        console.log(`Audio data length: ${data.audioData ? data.audioData.length : 0}`);
        
        try {
          if (data.audioData) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `voice_${timestamp}.m4a`;
            const filepath = path.join(audioDir, filename);
            
            console.log('[DEBUG] Saving audio file to:', filepath);
            // Convert base64 to buffer and save
            const audioBuffer = Buffer.from(data.audioData, 'base64');
            fs.writeFileSync(filepath, audioBuffer);
            console.log(`[DEBUG] Audio file saved: ${filename}, size: ${audioBuffer.length} bytes`);

            // Transcribe the audio using AssemblyAI
            try {
              console.log('[DEBUG] Starting transcription with AssemblyAI...');
              const transcription = await transcribeAudio(filepath);
              console.log('[DEBUG] Transcription complete:', transcription);

              // Process the transcription with Groq LLM
              try {
                console.log('[DEBUG] Starting Groq processing...');
                const response = await processWithGroq(transcription);
                console.log('[DEBUG] Groq processing complete:', response);

                // Convert the response to speech
                try {
                  console.log('[DEBUG] Starting text-to-speech conversion...');
                  const speechAudio = await convertTextToSpeech(response);
                  console.log('[DEBUG] Text-to-speech conversion complete');

                  // Send success response back to client with transcription, response, and audio
                  ws.send(JSON.stringify({
                    type: 'audio_received',
                    message: 'Voice processed successfully',
                    transcription: transcription,
                    response: response,
                    speechAudio: speechAudio,
                    filename: filename
                  }));
                  console.log('[DEBUG] Sent transcription, response, and speech audio to client.');
                } catch (ttsError: any) {
                  console.error('[ERROR] Text-to-speech failed:', ttsError);
                  // Send response without audio if TTS fails
                  ws.send(JSON.stringify({
                    type: 'audio_received',
                    message: 'Voice processed successfully (no audio)',
                    transcription: transcription,
                    response: response,
                    filename: filename
                  }));
                }
              } catch (groqError: any) {
                console.error('[ERROR] Groq processing failed:', groqError);
                ws.send(JSON.stringify({
                  type: 'audio_received',
                  message: 'Error during Groq processing: ' + (groqError.message || groqError),
                  error: true
                }));
              }
            } catch (transcriptionError: any) {
              console.error('[ERROR] AssemblyAI transcription failed:', transcriptionError);
              ws.send(JSON.stringify({
                type: 'audio_received',
                message: 'Error during transcription: ' + (transcriptionError.message || transcriptionError),
                error: true
              }));
            }
          } else {
            console.log('[ERROR] No audio data received');
            ws.send(JSON.stringify({
              type: 'audio_received',
              message: 'Error: No audio data received',
              error: true
            }));
          }
        } catch (error: any) {
          console.error('[ERROR] Error processing audio:', error);
          ws.send(JSON.stringify({
            type: 'audio_received',
            message: 'Error processing audio: ' + (error.message || error),
            error: true
          }));
        }
        break;

      default:
        console.log('Unknown message type:', data.type);
    }
  }

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connection_established',
    message: 'Connected to Voice Assistant Backend'
  }));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connectedClients: clients.size,
    timestamp: new Date().toISOString()
  });
});

// Get server info
app.get('/', (req, res) => {
  res.json({
    name: 'Voice Assistant Backend',
    version: '1.0.0',
    websocket: 'ws://localhost:3001',
    endpoints: {
      health: '/health'
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Voice Assistant Backend running on port ${PORT}`);
  console.log(`📡 WebSocket server ready at ws://localhost:${PORT}`);
  console.log(`🌐 HTTP server ready at http://localhost:${PORT}`);
  console.log(`🎤 Audio files will be saved to: ${audioDir}`);
}); 