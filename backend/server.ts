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

// Store connected clients with their state
interface ClientState {
  ws: WebSocket;
  isListening: boolean;
  isProcessing: boolean;
  currentTTSGeneration: any;
  currentRequestId: string | null;
  abortController: AbortController | null;
}

const clients = new Map<WebSocket, ClientState>();

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
async function processWithGroq(transcribedText: string, abortSignal?: AbortSignal): Promise<string> {
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
    }, {
      signal: abortSignal // Add abort signal support
    });

    const response = chatCompletion.choices[0]?.message?.content || 'I apologize, but I could not generate a response.';
    
    console.log('[DEBUG] Groq returned in', Date.now() - start, 'ms');
    console.log('[DEBUG] Groq response:', response);
    
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log('[DEBUG] Groq request was aborted');
      throw new Error('Request cancelled');
    }
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

  // Initialize client state
  const clientState: ClientState = {
    ws: ws,
    isListening: false,
    isProcessing: false,
    currentTTSGeneration: null,
    currentRequestId: null,
    abortController: null
  };
  clients.set(ws, clientState);

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

  // Function to handle AI interruption
  async function handleAIInterrupt(ws: WebSocket, clientState: ClientState) {
    try {
      console.log('[DEBUG] Handling AI interrupt...');
      
      // Abort any ongoing request
      if (clientState.abortController) {
        clientState.abortController.abort();
        console.log('[DEBUG] Aborted ongoing request');
      }

      // Cancel any ongoing TTS generation
      if (clientState.currentTTSGeneration) {
        // Note: Google TTS doesn't have a direct cancel method, but we can ignore the result
        clientState.currentTTSGeneration = null;
      }

      // Reset client state
      clientState.isProcessing = false;
      clientState.currentRequestId = null;
      clientState.abortController = null;
      
      // Send confirmation to client
      ws.send(JSON.stringify({
        type: 'ai_interrupted',
        message: 'AI response interrupted'
      }));
      
      console.log('[DEBUG] AI interrupt handled successfully');
    } catch (error: any) {
      console.error('[ERROR] Error handling AI interrupt:', error);
    }
  }

  // Function to handle processing cancellation
  async function handleProcessingCancel(ws: WebSocket, clientState: ClientState) {
    try {
      console.log('[DEBUG] Handling processing cancellation...');
      
      // Abort any ongoing request
      if (clientState.abortController) {
        clientState.abortController.abort();
        console.log('[DEBUG] Aborted ongoing request');
      }
      
      // Cancel ongoing processing
      clientState.isProcessing = false;
      clientState.currentTTSGeneration = null;
      clientState.currentRequestId = null;
      clientState.abortController = null;
      
      // Send confirmation to client
      ws.send(JSON.stringify({
        type: 'processing_cancelled',
        message: 'Processing cancelled'
      }));
      
      console.log('[DEBUG] Processing cancellation handled successfully');
    } catch (error: any) {
      console.error('[ERROR] Error handling processing cancel:', error);
    }
  }

  // Helper function to handle JSON messages
  async function handleJsonMessage(ws: WebSocket, data: any) {
    console.log('[DEBUG] Handling JSON message type:', data.type);
    const clientState = clients.get(ws);
    if (!clientState) return;

    // Handle different message types
    switch (data.type) {
      case 'start_listening':
        console.log('Client started listening (hold-to-talk)');
        clientState.isListening = true;
        clientState.isProcessing = false;
        ws.send(JSON.stringify({
          type: 'listening_started',
          message: 'Ready to receive audio'
        }));
        break;

      case 'stop_listening':
        console.log('Client stopped listening (released button)');
        clientState.isListening = false;
        ws.send(JSON.stringify({
          type: 'listening_stopped',
          message: 'Processing audio...'
        }));
        break;

      case 'interrupt_ai':
        console.log('🛑 AI interrupted by user');
        await handleAIInterrupt(ws, clientState);
        break;

      case 'cancel_processing':
        console.log('🛑 Processing cancelled by user');
        await handleProcessingCancel(ws, clientState);
        break;

      case 'audio_complete':
        console.log('🎤 Voice received!');
        
        // Use request ID from frontend, or generate one if not provided
        const requestId = data.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const abortController = new AbortController();
        
        // Update client state
        clientState.isProcessing = true;
        clientState.currentRequestId = requestId;
        clientState.abortController = abortController;
        
        console.log(`[DEBUG] Starting request ${requestId}`);
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

            // Send processing started notification
            ws.send(JSON.stringify({
              type: 'processing_started',
              message: 'AI is thinking...',
              requestId: requestId
            }));

            // Transcribe the audio using AssemblyAI
            try {
              console.log(`[DEBUG] [${requestId}] Starting transcription with AssemblyAI...`);
              const transcription = await transcribeAudio(filepath);
              console.log(`[DEBUG] [${requestId}] Transcription complete:`, transcription);

              // Check if this request was cancelled or superseded
              if (!clientState.isProcessing || clientState.currentRequestId !== requestId) {
                console.log(`[DEBUG] [${requestId}] Request was cancelled/superseded, skipping...`);
                return;
              }

              // Process the transcription with Groq LLM
              try {
                console.log(`[DEBUG] [${requestId}] Starting Groq processing...`);
                const response = await processWithGroq(transcription, abortController.signal);
                console.log(`[DEBUG] [${requestId}] Groq processing complete:`, response);

                // Check if this request was cancelled or superseded after Groq
                if (!clientState.isProcessing || clientState.currentRequestId !== requestId) {
                  console.log(`[DEBUG] [${requestId}] Request was cancelled/superseded after Groq, skipping TTS...`);
                  return;
                }

                // Convert the response to speech
                try {
                  console.log(`[DEBUG] [${requestId}] Starting text-to-speech conversion...`);
                  clientState.currentTTSGeneration = 'active'; // Mark TTS as active
                  const speechAudio = await convertTextToSpeech(response);
                  
                  // Final check if still the current request
                  if (!clientState.isProcessing || clientState.currentRequestId !== requestId || !clientState.currentTTSGeneration) {
                    console.log(`[DEBUG] [${requestId}] Request was cancelled/superseded during TTS, not sending audio`);
                    return;
                  }
                  
                  console.log(`[DEBUG] [${requestId}] Text-to-speech conversion complete`);

                  // Send success response back to client with transcription, response, and audio
                  ws.send(JSON.stringify({
                    type: 'audio_received',
                    message: 'Voice processed successfully',
                    transcription: transcription,
                    response: response,
                    speechAudio: speechAudio,
                    filename: filename,
                    requestId: requestId
                  }));
                  console.log(`[DEBUG] [${requestId}] Sent transcription, response, and speech audio to client.`);
                  
                  // Reset client state only if this is still the current request
                  if (clientState.currentRequestId === requestId) {
                    clientState.isProcessing = false;
                    clientState.currentTTSGeneration = null;
                    clientState.currentRequestId = null;
                    clientState.abortController = null;
                  }
                } catch (ttsError: any) {
                  if (ttsError.message === 'Request cancelled') {
                    console.log(`[DEBUG] [${requestId}] TTS was cancelled`);
                    return;
                  }
                  console.error(`[ERROR] [${requestId}] Text-to-speech failed:`, ttsError);
                  
                  // Reset state only if this is still the current request
                  if (clientState.currentRequestId === requestId) {
                    clientState.isProcessing = false;
                    clientState.currentTTSGeneration = null;
                    clientState.currentRequestId = null;
                    clientState.abortController = null;
                    
                    // Send response without audio if TTS fails
                    ws.send(JSON.stringify({
                      type: 'audio_received',
                      message: 'Voice processed successfully (no audio)',
                      transcription: transcription,
                      response: response,
                      filename: filename,
                      requestId: requestId
                    }));
                  }
                }
              } catch (groqError: any) {
                if (groqError.message === 'Request cancelled') {
                  console.log(`[DEBUG] [${requestId}] Groq request was cancelled`);
                  return;
                }
                console.error(`[ERROR] [${requestId}] Groq processing failed:`, groqError);
                
                // Reset state only if this is still the current request
                if (clientState.currentRequestId === requestId) {
                  clientState.isProcessing = false;
                  clientState.currentTTSGeneration = null;
                  clientState.currentRequestId = null;
                  clientState.abortController = null;
                  
                  ws.send(JSON.stringify({
                    type: 'audio_received',
                    message: 'Error during Groq processing: ' + (groqError.message || groqError),
                    error: true,
                    requestId: requestId
                  }));
                }
              }
            } catch (transcriptionError: any) {
              console.error(`[ERROR] [${requestId}] AssemblyAI transcription failed:`, transcriptionError);
              
              // Reset state only if this is still the current request
              if (clientState.currentRequestId === requestId) {
                clientState.isProcessing = false;
                clientState.currentTTSGeneration = null;
                clientState.currentRequestId = null;
                clientState.abortController = null;
                
                ws.send(JSON.stringify({
                  type: 'audio_received',
                  message: 'Error during transcription: ' + (transcriptionError.message || transcriptionError),
                  error: true,
                  requestId: requestId
                }));
              }
            }
          } else {
            console.log(`[ERROR] [${requestId}] No audio data received`);
            // Reset state
            if (clientState.currentRequestId === requestId) {
              clientState.isProcessing = false;
              clientState.currentTTSGeneration = null;
              clientState.currentRequestId = null;
              clientState.abortController = null;
            }
            ws.send(JSON.stringify({
              type: 'audio_received',
              message: 'Error: No audio data received',
              error: true,
              requestId: requestId
            }));
          }
        } catch (error: any) {
          console.error(`[ERROR] [${requestId}] Error processing audio:`, error);
          // Reset state
          if (clientState.currentRequestId === requestId) {
            clientState.isProcessing = false;
            clientState.currentTTSGeneration = null;
            clientState.currentRequestId = null;
            clientState.abortController = null;
          }
          ws.send(JSON.stringify({
            type: 'audio_received',
            message: 'Error processing audio: ' + (error.message || error),
            error: true,
            requestId: requestId
          }));
        }
        break;

      default:
        console.log('Unknown message type:', data.type);
    }
  }

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    const clientState = clients.get(ws);
    if (clientState?.abortController) {
      clientState.abortController.abort();
    }
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    const clientState = clients.get(ws);
    if (clientState?.abortController) {
      clientState.abortController.abort();
    }
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