import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Check if AssemblyAI API key is set
if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error('❌ ASSEMBLYAI_API_KEY is not set in .env file');
  console.log('Please get your API key from https://www.assemblyai.com/');
  process.exit(1);
}

// Initialize AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY
});

console.log('✅ AssemblyAI client initialized');

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

              // Send success response back to client with transcription
              ws.send(JSON.stringify({
                type: 'audio_received',
                message: 'Voice processed successfully',
                transcription: transcription,
                filename: filename
              }));
              console.log('[DEBUG] Sent transcription to client.');
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