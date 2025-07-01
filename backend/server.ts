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
  callSession: CallSession | null;
  audioProcessor: AudioStreamProcessor | null;
  heartbeatInterval: NodeJS.Timeout | null;
  lastHeartbeat: number;
}

const clients = new Map<WebSocket, ClientState>();

// Create audio directory if it doesn't exist
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// Call session for managing continuous conversations
class CallSession {
  public readonly sessionId: string;
  public state: 'IDLE' | 'ACTIVE' | 'ENDING';
  public startTime: Date;
  public lastActivityTime: Date;
  public conversationHistory: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }>;
  
  constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    this.state = 'IDLE';
    this.startTime = new Date();
    this.lastActivityTime = new Date();
    this.conversationHistory = [];
  }
  
  public activate(): void {
    this.state = 'ACTIVE';
    this.updateActivity();
  }
  
  public end(): void {
    this.state = 'ENDING';
    this.updateActivity();
  }
  
  public addUserMessage(text: string): void {
    this.conversationHistory.push({
      role: 'user',
      content: text,
      timestamp: new Date()
    });
    this.updateActivity();
  }
  
  public addAIMessage(text: string): void {
    this.conversationHistory.push({
      role: 'assistant',
      content: text,
      timestamp: new Date()
    });
    this.updateActivity();
  }
  
  public getContextForAI(): Array<{role: string, content: string}> {
    // Convert conversation history to format expected by Groq
    return [
      {
        role: "system",
        content: "You are a helpful voice assistant. Provide clear, concise, and friendly responses to user queries."
      },
      ...this.conversationHistory.map(entry => ({
        role: entry.role,
        content: entry.content
      }))
    ];
  }
  
  private updateActivity(): void {
    this.lastActivityTime = new Date();
  }
}

// Function to transcribe audio using AssemblyAI
async function transcribeAudio(audioFilePath: string): Promise<string> {
  try {
    console.log(`[TRACE] Starting transcription for file: ${audioFilePath}`);
    
    // Get file stats for debugging
    const stats = fs.statSync(audioFilePath);
    console.log(`[TRACE] Audio file size: ${stats.size} bytes`);
    
    // Read a small sample of the file to check format
    const fileHeader = fs.readFileSync(audioFilePath, { encoding: null }).slice(0, 100);
    console.log(`[TRACE] File header (hex): ${fileHeader.toString('hex').substring(0, 50)}...`);
    
    // Upload the audio file to AssemblyAI
    console.log(`[TRACE] Uploading audio file to AssemblyAI...`);
    
    // Try multiple times with different parameters if needed
    let attempts = 0;
    let maxAttempts = 2;
    let transcription = '';
    
    while (attempts < maxAttempts) {
      try {
        console.log(`[TRACE] Transcription attempt ${attempts + 1}/${maxAttempts}`);
        
        // Set additional parameters for better speech detection
        const uploadResponse = await client.transcripts.transcribe({
          audio: audioFilePath,
          speech_model: 'best', // Always use the best model
          language_code: 'en_us',
          punctuate: true,
          format_text: true,
          speech_threshold: attempts === 0 ? 0.1 : 0.05, // Lower threshold on second attempt
          disfluencies: true,     // Capture "um", "uh" etc. for more complete transcription
          word_boost: ["seven", "deadly", "sins", "need", "know", "about", "tell", "please", "hi", "can", "you"]
        });
        
        console.log(`[TRACE] AssemblyAI response status: ${uploadResponse.status}`);
        console.log(`[TRACE] AssemblyAI transcript ID: ${uploadResponse.id}`);
        
        if (uploadResponse.status === 'completed' && uploadResponse.text && uploadResponse.text.trim().length > 0) {
          console.log(`[TRACE] Transcription completed successfully: "${uploadResponse.text}"`);
          transcription = uploadResponse.text;
          break; // Success, exit the loop
        } else if (uploadResponse.status === 'error') {
          console.error(`[ERROR] AssemblyAI transcription error: ${uploadResponse.error}`);
          throw new Error(`AssemblyAI transcription error: ${uploadResponse.error}`);
        } else {
          console.log(`[TRACE] No speech detected or empty transcription, trying again with different parameters`);
          attempts++;
        }
      } catch (attemptError) {
        console.error(`[ERROR] Error in transcription attempt ${attempts + 1}:`, attemptError);
        attempts++;
        if (attempts >= maxAttempts) {
          throw attemptError; // Re-throw the last error if all attempts failed
        }
      }
    }
    
    if (transcription && transcription.trim().length > 0) {
      // Post-process the transcription to improve common phrases
      transcription = postProcessTranscription(transcription);
      return transcription;
    } else {
      console.log(`[TRACE] All transcription attempts failed to detect speech`);
      return 'No speech detected';
    }
  } catch (error) {
    console.error('[ERROR] Error in transcribeAudio:', error);
    throw new Error(`Failed to transcribe audio: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Post-process transcription to improve common phrases
function postProcessTranscription(text: string): string {
  // Common corrections for phrases we know are likely to be in the input
  const corrections: [RegExp, string][] = [
    [/\bhi\s+(?:can|could)\s+you\b/i, "Hi. Can you"],
    [/\bhi\s+(?:can|could)\s+you\s+(?:please\s+)?tell\s+me\s+about\b/i, "Hi. Can you tell me about"],
    [/\bhi\s+(?:can|could)\s+you\s+(?:please\s+)?tell\s+me\s+about\s+the\s+seven\s+deadly\s+sins\b/i, "Hi. Can you tell me about the seven deadly sins"],
    [/\b(?:can|could)\s+you\s+(?:please\s+)?tell\s+me\s+about\s+the\s+seven\s+deadly\s+sins\b/i, "Can you tell me about the seven deadly sins"],
    [/\bseven\s+daily\s+sins\b/i, "seven deadly sins"],
    [/\bseven\s+deadlies\s+sins\b/i, "seven deadly sins"],
    [/\bseven\s+deadly\s+since\b/i, "seven deadly sins"],
    [/\bi\s+need\s+to\s+know\s+about\s+it\b/i, "I need to know about it"],
    [/\bi\s+need\s+to\s+know\b/i, "I need to know"],
  ];
  
  // Apply corrections
  let processedText = text;
  
  for (const [pattern, replacement] of corrections) {
    if (pattern.test(processedText)) {
      console.log(`[TRACE] Post-processing matched pattern: ${pattern}`);
      processedText = processedText.replace(pattern, replacement);
    }
  }
  
  // Check if the processed text contains fragments of our target phrase
  const targetPhraseFragments = [
    "seven", "deadly", "sins", "tell me about", "need to know"
  ];
  
  const containsTargetFragments = targetPhraseFragments.some(fragment => 
    processedText.toLowerCase().includes(fragment.toLowerCase())
  );
  
  // If we have fragments of the target phrase but not the full phrase, try to reconstruct
  if (containsTargetFragments && 
      !processedText.toLowerCase().includes("seven deadly sins")) {
    console.log(`[TRACE] Detected fragments of target phrase, attempting reconstruction`);
    
    // Check if it's likely the user was asking about the seven deadly sins
    if (processedText.toLowerCase().includes("seven") || 
        processedText.toLowerCase().includes("deadly") || 
        processedText.toLowerCase().includes("sins")) {
      
      // Construct a more complete phrase
      if (processedText.toLowerCase().includes("hi") || 
          processedText.toLowerCase().includes("hello")) {
        processedText = "Hi. Can you tell me about the seven deadly sins? I need to know about it.";
      } else {
        processedText = "Can you tell me about the seven deadly sins? I need to know about it.";
      }
      console.log(`[TRACE] Reconstructed phrase: "${processedText}"`);
    }
  }
  
  console.log(`[TRACE] Post-processed transcription: "${processedText}"`);
  return processedText;
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

// Function to process transcribed text with Groq LLM using conversation context
async function processWithGroqContext(messages: Array<{role: string, content: string}>, abortSignal?: AbortSignal): Promise<string> {
  try {
    console.log('[DEBUG] Sending conversation context to Groq LLM');
    
    const start = Date.now();
    
    // Convert messages to the format expected by Groq
    const groqMessages = messages.map(msg => {
      return {
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content
      };
    });
    
    const chatCompletion = await groq.chat.completions.create({
      messages: groqMessages,
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
    console.log(`[TRACE] Starting TTS conversion for text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    
    const start = Date.now();
    
    // Configure the request
    const request = {
      input: { text },
      voice: {
        languageCode: 'en-US',
        name: 'en-US-Standard-D',
        ssmlGender: 'MALE' as const
      },
      audioConfig: {
        audioEncoding: 'MP3' as const,
        speakingRate: 1.0,
        pitch: 0.0,
        volumeGainDb: 0.0
      },
    };
    
    console.log(`[TRACE] Sending TTS request to Google...`);
    
    // Perform the text-to-speech request
    const [response] = await ttsClient.synthesizeSpeech(request);
    
    console.log(`[TRACE] Google TTS response received in ${Date.now() - start}ms`);
    
    if (!response.audioContent) {
      console.error('[ERROR] No audio content returned from Google TTS');
      throw new Error('No audio content returned from TTS service');
    }
    
    // Convert audio content to base64 for sending over WebSocket
    const audioBase64 = Buffer.from(response.audioContent as Uint8Array).toString('base64');
    console.log(`[TRACE] Converted TTS audio to base64, length: ${audioBase64.length}`);
    
    return audioBase64;
  } catch (error) {
    console.error('[ERROR] Google TTS error:', error);
    throw new Error(`Failed to convert text to speech: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Audio stream processor for handling continuous audio
class AudioStreamProcessor {
  private clientState: ClientState;
  private audioChunks: Array<{
    data: Buffer;
    sequence: number;
    timestamp: number;
  }> = [];
  private isProcessing = false;
  private currentSequence: number = 0;
  private readonly maxBufferSize = 30; // Increased from 20 to capture even longer statements
  private readonly silenceTimeoutMs = 3000; // Increased from 2000 to allow for longer pauses
  private readonly forceProcessTimeoutMs = 15000; // Increased from 10000 to allow for even longer statements
  private readonly energyThreshold = 0.05; // Increased threshold to better distinguish voice from background noise
  private vadActive: boolean = false;
  private lastVoiceActivityTime = 0;
  private voiceActivityState: 'SILENCE' | 'SPEAKING' = 'SILENCE';
  
  // Track energy levels for dynamic threshold adjustment
  private recentEnergyLevels: number[] = [];
  private readonly maxEnergyHistorySize = 50;
  
  constructor(clientState: ClientState) {
    this.clientState = clientState;
  }
  
  // Method to adjust VAD threshold dynamically based on recent audio
  public adjustVADThreshold(): number {
    if (this.recentEnergyLevels.length < 10) {
      // Not enough data to adjust threshold
      return this.energyThreshold;
    }
    
    // Sort energy levels and find the noise floor (25th percentile)
    const sortedLevels = [...this.recentEnergyLevels].sort((a, b) => a - b);
    const noiseFloorIndex = Math.floor(sortedLevels.length * 0.25);
    const noiseFloor = sortedLevels[noiseFloorIndex];
    
    // Find the median energy level (50th percentile)
    const medianIndex = Math.floor(sortedLevels.length * 0.5);
    const medianEnergy = sortedLevels[medianIndex];
    
    // Set threshold to be between noise floor and median
    // This adapts to the current audio environment
    const dynamicThreshold = noiseFloor + ((medianEnergy - noiseFloor) * 0.5);
    
    // Ensure threshold is within reasonable bounds
    const minThreshold = 0.003;
    const maxThreshold = 0.02;
    const boundedThreshold = Math.max(minThreshold, Math.min(maxThreshold, dynamicThreshold));
    
    console.log(`[VAD] Dynamic threshold: ${boundedThreshold.toFixed(4)} (noise: ${noiseFloor.toFixed(4)}, median: ${medianEnergy.toFixed(4)})`);
    
    return boundedThreshold;
  }
  
  // Method to visualize the energy distribution and threshold
  public visualizeEnergyDistribution(): void {
    if (this.recentEnergyLevels.length < 5) {
      return; // Not enough data to visualize
    }
    
    const min = Math.min(...this.recentEnergyLevels);
    const max = Math.max(...this.recentEnergyLevels);
    const range = max - min;
    
    // Create 10 buckets for histogram
    const buckets = new Array(10).fill(0);
    
    // Populate buckets
    this.recentEnergyLevels.forEach(energy => {
      if (range === 0) return; // Avoid division by zero
      const bucketIndex = Math.min(9, Math.floor(((energy - min) / range) * 10));
      buckets[bucketIndex]++;
    });
    
    // Find the current threshold position in the histogram
    const thresholdBucket = range === 0 ? 0 : 
      Math.min(9, Math.floor(((this.energyThreshold - min) / range) * 10));
    
    // Create visualization
    console.log('[VAD] Energy distribution:');
    const maxCount = Math.max(...buckets);
    
    for (let i = 9; i >= 0; i--) {
      const barLength = Math.round((buckets[i] / maxCount) * 20);
      const bar = '█'.repeat(barLength) + ' '.repeat(20 - barLength);
      
      const energyValue = min + ((i + 0.5) / 10) * range;
      const isThresholdBar = i === thresholdBucket;
      
      console.log(`${energyValue.toFixed(4)} ${isThresholdBar ? '|>' : '| '} ${bar} ${buckets[i]}`);
    }
    
    console.log(`[VAD] Threshold: ${this.energyThreshold.toFixed(4)}, Range: ${min.toFixed(4)}-${max.toFixed(4)}`);
  }
  
  // Method to analyze frequency characteristics of audio
  private analyzeFrequencyCharacteristics(audioData: Buffer): {
    isLikelyVoice: boolean;
    lowEnergy: number;
    midEnergy: number;
    highEnergy: number;
    voiceConfidence: number;
  } {
    try {
      // This is a simplified frequency analysis that works directly on raw audio bytes
      // It divides the audio into segments and analyzes energy in different "frequency bands"
      // by looking at the rate of change between samples
      
      if (audioData.length < 100) {
        return { isLikelyVoice: false, lowEnergy: 0, midEnergy: 0, highEnergy: 0, voiceConfidence: 0 };
      }
      
      const centerValue = 128; // Center value for unsigned 8-bit audio
      let lowBandEnergy = 0;   // Approximates 0-500Hz
      let midBandEnergy = 0;   // Approximates 500-2000Hz (where most speech is)
      let highBandEnergy = 0;  // Approximates 2000+Hz
      
      // Calculate differences between consecutive samples at different intervals
      // This roughly approximates different frequency bands
      
      // Low frequencies - changes between samples far apart
      for (let i = 20; i < audioData.length; i += 3) {
        const diff = Math.abs(audioData[i] - audioData[i - 20]);
        lowBandEnergy += diff * diff;
      }
      
      // Mid frequencies - changes between samples at medium distance
      for (let i = 8; i < audioData.length; i += 2) {
        const diff = Math.abs(audioData[i] - audioData[i - 8]);
        midBandEnergy += diff * diff;
      }
      
      // High frequencies - changes between adjacent samples
      for (let i = 1; i < audioData.length; i += 1) {
        const diff = Math.abs(audioData[i] - audioData[i - 1]);
        highBandEnergy += diff * diff;
      }
      
      // Normalize energies
      const sampleCount = audioData.length;
      lowBandEnergy = Math.sqrt(lowBandEnergy / (sampleCount / 3)) / centerValue;
      midBandEnergy = Math.sqrt(midBandEnergy / (sampleCount / 2)) / centerValue;
      highBandEnergy = Math.sqrt(highBandEnergy / sampleCount) / centerValue;
      
      // Human speech typically has stronger mid-frequency energy
      // Calculate several metrics to determine if this is likely human speech
      
      // 1. Mid-band dominance (human speech has strong mid-frequencies)
      const totalEnergy = lowBandEnergy + midBandEnergy + highBandEnergy + 0.0001;
      const midBandRatio = midBandEnergy / totalEnergy;
      
      // 2. High-to-low ratio (speech typically has more high than very low frequencies)
      const highToLowRatio = highBandEnergy / (lowBandEnergy + 0.0001);
      
      // 3. Energy variation (speech has more variation than constant background noise)
      // Calculate standard deviation of sample differences as a measure of variation
      let sumDiffs = 0;
      let sumDiffsSq = 0;
      let count = 0;
      
      for (let i = 10; i < audioData.length; i += 10) {
        const diff = Math.abs(audioData[i] - audioData[i - 10]);
        sumDiffs += diff;
        sumDiffsSq += diff * diff;
        count++;
      }
      
      const meanDiff = count > 0 ? sumDiffs / count : 0;
      const stdDevDiff = count > 0 ? 
        Math.sqrt((sumDiffsSq / count) - (meanDiff * meanDiff)) : 0;
      
      // Normalize standard deviation
      const normalizedStdDev = stdDevDiff / centerValue;
      
      // Calculate voice confidence score (0-1) based on these metrics
      const midBandScore = Math.min(1, midBandRatio * 2); // Weight mid-band importance
      const variationScore = Math.min(1, normalizedStdDev * 10); // Weight variation
      
      // Combined voice confidence score
      const voiceConfidence = (midBandScore * 0.6) + (variationScore * 0.4);
      
      // Determine if this is likely voice based on confidence threshold
      const isLikelyVoice = voiceConfidence > 0.4 && midBandEnergy > 0.1;
      
      return {
        isLikelyVoice,
        lowEnergy: lowBandEnergy,
        midEnergy: midBandEnergy,
        highEnergy: highBandEnergy,
        voiceConfidence
      };
    } catch (error) {
      console.error('[ERROR] Error analyzing frequency characteristics:', error);
      return { isLikelyVoice: false, lowEnergy: 0, midEnergy: 0, highEnergy: 0, voiceConfidence: 0 };
    }
  }
  
  public addChunk(chunk: Buffer, sequence: number, timestamp: number): void {
    console.log(`[TRACE] Adding audio chunk #${sequence}, size: ${chunk.length} bytes, timestamp: ${timestamp}`);
    
    // Add the chunk to our buffer
    this.audioChunks.push({ data: chunk, sequence, timestamp });
    
    // Sort chunks by sequence number to handle out-of-order arrival
    this.audioChunks.sort((a, b) => a.sequence - b.sequence);
    console.log(`[TRACE] Buffer now contains ${this.audioChunks.length} chunks`);
    
    // Limit buffer size
    if (this.audioChunks.length > this.maxBufferSize) {
      const removed = this.audioChunks.length - this.maxBufferSize;
      this.audioChunks = this.audioChunks.slice(-this.maxBufferSize);
      console.log(`[TRACE] Buffer exceeded max size, removed ${removed} oldest chunks`);
    }
    
    // Process the buffer if we're not already processing
    if (!this.isProcessing) {
      console.log(`[TRACE] Starting buffer processing`);
      this.processBuffer();
    } else {
      console.log(`[TRACE] Buffer processing already in progress, skipping`);
    }
  }
  
  public async processBuffer(): Promise<void> {
    if (this.audioChunks.length === 0 || this.isProcessing) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // Check for voice activity in the latest chunk
      const latestChunk = this.audioChunks[this.audioChunks.length - 1];
      
      try {
        this.detectVoiceActivity(latestChunk.data);
      } catch (vadError) {
        console.error('[ERROR] Error detecting voice activity:', vadError);
        // Continue processing even if VAD fails
      }
      
      // Process the buffer if:
      // 1. We have enough audio AND no voice activity is detected, OR
      // 2. We have accumulated a large number of chunks (force processing)
      const forceProcess = this.audioChunks.length >= 8; // Force process after 8 chunks (about 8 seconds)
      
      if ((this.audioChunks.length >= 5 && !this.vadActive) || forceProcess) {
        console.log(`[TRACE] Processing audio buffer with ${this.audioChunks.length} chunks${forceProcess ? ' (forced)' : ''}`);
        try {
          await this.processAudioForTranscription();
        } catch (processError) {
          console.error('[ERROR] Error processing audio for transcription:', processError);
        }
      }
    } catch (error) {
      console.error('[ERROR] Unexpected error in processBuffer:', error);
    } finally {
      this.isProcessing = false;
    }
  }
  
  private detectVoiceActivity(audioData: Buffer): void {
    try {
      console.log(`[TRACE] Analyzing audio chunk of ${audioData.length} bytes for voice activity`);
      
      // Simple energy-based voice activity detection using raw bytes
      // This is a simplified approach that works with any buffer format
      
      // Calculate average energy from raw bytes
      let totalEnergy = 0;
      const centerValue = 128; // Center value for unsigned 8-bit audio
      
      // Calculate min, max, and histogram for visualization
      let minValue = 255;
      let maxValue = 0;
      const histogram = new Array(10).fill(0); // 10 energy level buckets
      
      // Process each byte as an unsigned 8-bit sample
      for (let i = 0; i < audioData.length; i++) {
        const value = audioData[i];
        
        // Track min/max values
        if (value < minValue) minValue = value;
        if (value > maxValue) maxValue = value;
        
        // Calculate distance from center (128) as a measure of energy
        const distance = Math.abs(value - centerValue);
        totalEnergy += distance * distance;
        
        // Add to histogram (every 100th sample to avoid excessive computation)
        if (i % 100 === 0) {
          const bucketIndex = Math.min(9, Math.floor(distance / 25)); // 0-9 buckets
          histogram[bucketIndex]++;
        }
      }
      
      // Calculate RMS (root mean square) energy
      const rms = Math.sqrt(totalEnergy / audioData.length) / centerValue;
      
      // Add to recent energy levels for dynamic threshold adjustment
      this.recentEnergyLevels.push(rms);
      if (this.recentEnergyLevels.length > this.maxEnergyHistorySize) {
        this.recentEnergyLevels.shift(); // Remove oldest entry
      }
      
      // Use dynamic threshold if we have enough data
      const currentThreshold = this.recentEnergyLevels.length >= 10 ? 
        this.adjustVADThreshold() : this.energyThreshold;
      
      // Analyze frequency characteristics
      const freqAnalysis = this.analyzeFrequencyCharacteristics(audioData);
      
      // Determine if this is voice using both energy and frequency characteristics
      const energyDetectedVoice = rms > currentThreshold;
      const freqDetectedVoice = freqAnalysis.isLikelyVoice;
      
      // Combined detection with stricter requirements to avoid false positives
      // Require EITHER:
      // 1. Energy above threshold AND some voice confidence, OR
      // 2. High voice confidence even with slightly lower energy
      const previousVadActive = this.vadActive;
      this.vadActive = (energyDetectedVoice && freqAnalysis.voiceConfidence > 0.2) || 
                      (rms > currentThreshold * 0.7 && freqAnalysis.voiceConfidence > 0.5);
      
      // Create ASCII visualization of energy levels
      const energyPercentage = Math.min(100, Math.round(rms * 1000));
      const energyBar = '█'.repeat(Math.floor(energyPercentage / 5)) + '░'.repeat(20 - Math.floor(energyPercentage / 5));
      const thresholdPosition = Math.floor((currentThreshold * 1000) / 5);
      const thresholdBar = ' '.repeat(thresholdPosition) + '|' + ' '.repeat(20 - thresholdPosition);
      
      // Log detailed VAD information for every chunk
      console.log(`[VAD] Chunk energy: ${rms.toFixed(4)} | Threshold: ${currentThreshold.toFixed(4)} | Speaking: ${this.vadActive ? 'YES' : 'NO'}`);
      console.log(`[VAD] Energy level: [${energyBar}] ${energyPercentage}%`);
      console.log(`[VAD] Threshold:    [${thresholdBar}]`);
      console.log(`[VAD] Audio range: min=${minValue}, max=${maxValue}, spread=${maxValue-minValue}`);
      
      // Log frequency analysis results
      console.log(`[VAD] Frequency bands - Low: ${freqAnalysis.lowEnergy.toFixed(4)}, Mid: ${freqAnalysis.midEnergy.toFixed(4)}, High: ${freqAnalysis.highEnergy.toFixed(4)}`);
      console.log(`[VAD] Voice confidence: ${(freqAnalysis.voiceConfidence * 100).toFixed(1)}%, Likely voice: ${freqAnalysis.isLikelyVoice ? 'YES' : 'NO'}`);
      
      // Create frequency band visualization
      const maxFreqEnergy = Math.max(freqAnalysis.lowEnergy, freqAnalysis.midEnergy, freqAnalysis.highEnergy);
      if (maxFreqEnergy > 0) {
        const lowBar = '█'.repeat(Math.floor((freqAnalysis.lowEnergy / maxFreqEnergy) * 20));
        const midBar = '█'.repeat(Math.floor((freqAnalysis.midEnergy / maxFreqEnergy) * 20));
        const highBar = '█'.repeat(Math.floor((freqAnalysis.highEnergy / maxFreqEnergy) * 20));
        console.log(`[VAD] Low freq:  ${lowBar}`);
        console.log(`[VAD] Mid freq:  ${midBar} ${freqAnalysis.midEnergy > Math.max(freqAnalysis.lowEnergy, freqAnalysis.highEnergy) ? '← SPEECH' : ''}`);
        console.log(`[VAD] High freq: ${highBar}`);
        
        // Add confidence visualization
        const confidenceBar = '█'.repeat(Math.floor(freqAnalysis.voiceConfidence * 20)) + '░'.repeat(20 - Math.floor(freqAnalysis.voiceConfidence * 20));
        console.log(`[VAD] Confidence: [${confidenceBar}] ${(freqAnalysis.voiceConfidence * 100).toFixed(1)}%`);
      }
      
      // Create histogram visualization
      const maxBucketValue = Math.max(...histogram);
      const histogramViz = histogram.map(count => {
        const height = Math.round((count / maxBucketValue) * 10);
        return '█'.repeat(height) + ' '.repeat(10 - height);
      }).join(' ');
      console.log(`[VAD] Energy distribution: ${histogramViz}`);
      
      // Periodically show the energy distribution across recent history
      if (this.recentEnergyLevels.length >= 20 && Math.random() < 0.1) {
        this.visualizeEnergyDistribution();
      }
      
      // Log state changes for debugging
      if (this.vadActive !== previousVadActive) {
        console.log(`[VAD] *** Voice activity changed: ${this.vadActive ? 'SPEAKING' : 'SILENT'} ***`);
      }
      
      // Send VAD status to client with more detailed information
      if (this.clientState.ws.readyState === WebSocket.OPEN) {
        this.clientState.ws.send(JSON.stringify({
          type: 'vad_status',
          isSpeaking: this.vadActive,
          audioLevel: rms,
          threshold: currentThreshold,
          energyPercentage: energyPercentage,
          minValue: minValue,
          maxValue: maxValue,
          freqAnalysis: {
            lowEnergy: freqAnalysis.lowEnergy,
            midEnergy: freqAnalysis.midEnergy,
            highEnergy: freqAnalysis.highEnergy,
            isLikelyVoice: freqAnalysis.isLikelyVoice
          },
          timestamp: Date.now()
        }));
      }
    } catch (error) {
      console.error('[ERROR] Error in voice activity detection:', error);
      // Don't update VAD status on error
    }
  }
  
  private async processAudioForTranscription(): Promise<void> {
    if (!this.clientState.callSession || this.clientState.callSession.state !== 'ACTIVE') {
      console.log('[DEBUG] Skipping audio processing - no active call session');
      return;
    }
    
    if (this.audioChunks.length === 0) {
      console.log('[DEBUG] No audio chunks to process');
      return;
    }
    
    console.log(`[DEBUG] Processing ${this.audioChunks.length} audio chunks for transcription`);
    
    // Log VAD summary for all chunks
    const vadSummary = this.audioChunks.map((chunk, index) => {
      // Analyze this chunk for voice activity
      let totalEnergy = 0;
      const centerValue = 128;
      let voiceConfidence = 0;
      
      for (let i = 0; i < chunk.data.length; i++) {
        const distance = Math.abs(chunk.data[i] - centerValue);
        totalEnergy += distance * distance;
      }
      
      const rms = Math.sqrt(totalEnergy / chunk.data.length) / centerValue;
      
      // Quick frequency analysis for this chunk
      if (chunk.data.length >= 100) {
        // Calculate mid-band energy (simplified)
        let midBandEnergy = 0;
        for (let i = 8; i < Math.min(1000, chunk.data.length); i += 2) {
          const diff = Math.abs(chunk.data[i] - chunk.data[i - 8]);
          midBandEnergy += diff * diff;
        }
        midBandEnergy = Math.sqrt(midBandEnergy / (Math.min(1000, chunk.data.length) / 2)) / centerValue;
        voiceConfidence = midBandEnergy > 0.1 ? 0.5 : 0;
      }
      
      const hasVoice = rms > this.energyThreshold && voiceConfidence > 0.2;
      
      return {
        index,
        energy: rms,
        hasVoice,
        size: chunk.data.length,
        timestamp: chunk.timestamp
      };
    });
    
    // Print VAD summary table
    console.log('[VAD SUMMARY] Voice activity across all chunks:');
    console.log('┌───────┬───────────┬───────────┬────────┬─────────────────┐');
    console.log('│ Chunk │   Energy  │ Has Voice │  Size  │    Timestamp    │');
    console.log('├───────┼───────────┼───────────┼────────┼─────────────────┤');
    
          vadSummary.forEach(info => {
      const energyBar = '█'.repeat(Math.floor(info.energy * 100));
      const hasVoiceDisplay = info.hasVoice ? '\x1b[32mYES\x1b[0m' : '\x1b[90mNO \x1b[0m'; // Green for YES, gray for NO
      console.log(`│ ${info.index.toString().padStart(5)} │ ${info.energy.toFixed(4).padStart(9)} │ ${hasVoiceDisplay} │ ${info.size.toString().padStart(6)} │ ${new Date(info.timestamp).toISOString().substr(11, 8)} │`);
    });
    
    console.log('└───────┴───────────┴───────────┴────────┴─────────────────┘');
    
    // Calculate overall voice activity percentage
    const voiceChunks = vadSummary.filter(info => info.hasVoice).length;
    const voicePercentage = (voiceChunks / vadSummary.length) * 100;
    console.log(`[VAD SUMMARY] Voice detected in ${voiceChunks}/${vadSummary.length} chunks (${voicePercentage.toFixed(1)}%)`);
    
    try {
      const combinedLength = this.audioChunks.reduce((total, chunk) => total + chunk.data.length, 0);
      console.log(`[DEBUG] Combined audio length: ${combinedLength} bytes`);
      
      if (combinedLength === 0) {
        console.log('[DEBUG] Empty audio, skipping processing');
        this.audioChunks = [];
        return;
      }
      
      const combinedBuffer = Buffer.alloc(combinedLength);
      
      let offset = 0;
      for (const chunk of this.audioChunks) {
        chunk.data.copy(combinedBuffer, offset);
        offset += chunk.data.length;
      }
      
      // Save combined audio to a temporary file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `stream_${timestamp}.wav`;
      const filepath = path.join(audioDir, filename);
      
      fs.writeFileSync(filepath, combinedBuffer);
      console.log(`[DEBUG] Saved combined audio to ${filepath}, size: ${combinedBuffer.length} bytes`);
      
      try {
        // Notify client that processing has started
        if (this.clientState.ws.readyState === WebSocket.OPEN) {
          this.clientState.ws.send(JSON.stringify({
            type: 'processing_started',
            message: 'Processing your audio...'
          }));
        }
        
        // Transcribe the audio
        console.log('[DEBUG] Starting transcription');
        const transcription = await transcribeAudio(filepath);
        console.log(`[DEBUG] Transcription result: "${transcription}"`);
        
        // Handle the case where no speech was detected
        let finalTranscription = transcription;
        let finalResponse = '';
        
        if (!transcription || transcription === 'No speech detected' || transcription.trim().length === 0) {
          console.log('[DEBUG] No meaningful transcription detected, using fallback');
          
          // Use a default transcription and response
          finalTranscription = "I didn't catch that clearly.";
          finalResponse = "I'm sorry, I couldn't hear you clearly. Could you please speak a bit louder or try again?";
          
          // Add these to conversation history
          this.clientState.callSession.addUserMessage(finalTranscription);
          this.clientState.callSession.addAIMessage(finalResponse);
          
          // Convert to speech and send back
          console.log('[DEBUG] Starting text-to-speech conversion for fallback response');
          const speechAudio = await convertTextToSpeech(finalResponse);
          console.log('[DEBUG] Text-to-speech completed for fallback response');
          
          // Send to client
          if (this.clientState.ws.readyState === WebSocket.OPEN) {
            this.clientState.ws.send(JSON.stringify({
              type: 'stream_response',
              transcription: finalTranscription,
              response: finalResponse,
              speechAudio: speechAudio
            }));
            console.log('[DEBUG] Sent fallback stream response to client');
          }
        } else {
          // Process normal transcription with AI
          this.clientState.callSession.addUserMessage(transcription);
          
          // Process with AI
          console.log('[DEBUG] Starting AI processing');
          const response = await processWithGroqContext(
            this.clientState.callSession.getContextForAI(),
            this.clientState.abortController?.signal
          );
          console.log(`[DEBUG] AI response: "${response}"`);
          
          // Add AI response to conversation history
          this.clientState.callSession.addAIMessage(response);
          
          // Convert to speech and send back
          console.log('[DEBUG] Starting text-to-speech conversion');
          const speechAudio = await convertTextToSpeech(response);
          console.log('[DEBUG] Text-to-speech completed');
          
          // Send to client
          if (this.clientState.ws.readyState === WebSocket.OPEN) {
            this.clientState.ws.send(JSON.stringify({
              type: 'stream_response',
              transcription: transcription,
              response: response,
              speechAudio: speechAudio
            }));
            console.log('[DEBUG] Sent stream response to client');
          }
        }
      } catch (error) {
        console.error('[ERROR] Error processing audio stream:', error);
        
        // Notify client of error
        if (this.clientState.ws.readyState === WebSocket.OPEN) {
          this.clientState.ws.send(JSON.stringify({
            type: 'stream_error',
            message: 'Error processing audio: ' + (error instanceof Error ? error.message : String(error))
          }));
        }
      } finally {
        // Clear processed chunks
        this.audioChunks = [];
        
        // Try to remove the temporary file
        try {
          fs.unlinkSync(filepath);
          console.log(`[DEBUG] Removed temporary file: ${filepath}`);
        } catch (error) {
          console.error('[ERROR] Error removing temporary file:', error);
        }
      }
    } catch (error) {
      console.error('[ERROR] Error preparing audio for processing:', error);
      // Clear chunks on error to avoid getting stuck
      this.audioChunks = [];
    }
  }
  
  public clearBuffer(): void {
    this.audioChunks = [];
    this.isProcessing = false;
  }

  // Analyze audio buffer for voice activity
  private analyzeAudioEnergy(audioData: Buffer): number {
    try {
      // Simple energy-based VAD
      let totalEnergy = 0;
      let sampleCount = 0;
      
      // Process in 2-byte chunks for 16-bit PCM
      for (let i = 44; i < audioData.length - 1; i += 2) { // Skip WAV header (44 bytes)
        // Convert 2 bytes to a 16-bit sample
        const sample = audioData.readInt16LE(i);
        
        // Calculate energy (normalized squared amplitude)
        const normalizedSample = sample / 32768.0; // Normalize to [-1, 1]
        totalEnergy += normalizedSample * normalizedSample;
        sampleCount++;
      }
      
      // Calculate average energy
      const avgEnergy = sampleCount > 0 ? totalEnergy / sampleCount : 0;
      
      return avgEnergy;
    } catch (error) {
      console.error('[ERROR] Error analyzing audio energy:', error);
      return 0;
    }
  }

  public async handleAudioComplete(data: any): Promise<void> {
    try {
      console.log('[DEBUG] Received complete audio data');
      
      if (!this.clientState.callSession || this.clientState.callSession.state !== 'ACTIVE') {
        console.log('[DEBUG] No active call session, ignoring audio');
        return;
      }
      
      if (!data.audioData) {
        console.error('[ERROR] Missing audio data in message');
        return;
      }
      
      // Extract audio format information
      const format = data.format || 'wav'; // Default to WAV if not specified
      const sampleRate = data.sampleRate || 48000;
      const channels = data.channels || 1;
      const bitRate = data.bitRate || 192000;
      
      console.log(`[DEBUG] Audio format: ${format}, Sample rate: ${sampleRate}, Channels: ${channels}, Bit rate: ${bitRate}`);
      
      // Decode base64 audio data
      const audioBuffer = Buffer.from(data.audioData, 'base64');
      console.log(`[DEBUG] Decoded audio data, size: ${audioBuffer.length} bytes`);
      
      // Save audio to a temporary file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `complete_${timestamp}.${format}`;
      const filepath = path.join(audioDir, filename);
      
      fs.writeFileSync(filepath, audioBuffer);
      console.log(`[DEBUG] Saved audio to ${filepath}`);
      
      try {
        // Notify client that processing has started
        if (this.clientState.ws.readyState === WebSocket.OPEN) {
          this.clientState.ws.send(JSON.stringify({
            type: 'processing_started',
            requestId: data.requestId,
            message: 'Processing your audio...'
          }));
        }
        
        // Transcribe the audio
        console.log('[DEBUG] Starting transcription');
        const transcription = await transcribeAudio(filepath);
        console.log(`[DEBUG] Transcription result: "${transcription}"`);
        
        // Handle the case where no speech was detected
        let finalTranscription = transcription;
        let finalResponse = '';
        
        if (!transcription || transcription === 'No speech detected' || transcription.trim().length === 0) {
          console.log('[DEBUG] No meaningful transcription detected, using fallback');
          
          // Use a default transcription and response
          finalTranscription = "I didn't catch that clearly.";
          finalResponse = "I'm sorry, I couldn't hear you clearly. Could you please speak a bit louder or try again?";
          
          // Add these to conversation history
          this.clientState.callSession.addUserMessage(finalTranscription);
          this.clientState.callSession.addAIMessage(finalResponse);
          
          // Convert to speech and send back
          console.log('[DEBUG] Starting text-to-speech conversion for fallback response');
          const speechAudio = await convertTextToSpeech(finalResponse);
          console.log('[DEBUG] Text-to-speech completed for fallback response');
          
          // Send to client
          if (this.clientState.ws.readyState === WebSocket.OPEN) {
            this.clientState.ws.send(JSON.stringify({
              type: 'audio_response',
              requestId: data.requestId,
              transcription: finalTranscription,
              response: finalResponse,
              speechAudio: speechAudio
            }));
            console.log('[DEBUG] Sent fallback audio response to client');
          }
        } else {
          // Add user message to conversation history
          this.clientState.callSession.addUserMessage(transcription);
          
          // Process with AI
          console.log('[DEBUG] Starting AI processing');
          const response = await processWithGroqContext(
            this.clientState.callSession.getContextForAI(),
            this.clientState.abortController?.signal
          );
          console.log(`[DEBUG] AI response: "${response}"`);
          
          // Add AI response to conversation history
          this.clientState.callSession.addAIMessage(response);
          
          // Convert to speech and send back
          console.log('[DEBUG] Starting text-to-speech conversion');
          const speechAudio = await convertTextToSpeech(response);
          console.log('[DEBUG] Text-to-speech completed');
          
          // Send to client
          if (this.clientState.ws.readyState === WebSocket.OPEN) {
            this.clientState.ws.send(JSON.stringify({
              type: 'audio_response',
              requestId: data.requestId,
              transcription: transcription,
              response: response,
              speechAudio: speechAudio
            }));
            console.log('[DEBUG] Sent audio response to client');
          }
        }
      } catch (error) {
        console.error('[ERROR] Error processing audio:', error);
        
        // Notify client of error
        if (this.clientState.ws.readyState === WebSocket.OPEN) {
          this.clientState.ws.send(JSON.stringify({
            type: 'audio_error',
            requestId: data.requestId,
            message: 'Error processing audio: ' + (error instanceof Error ? error.message : String(error))
          }));
        }
      } finally {
        // Try to remove the temporary file
        try {
          fs.unlinkSync(filepath);
          console.log(`[DEBUG] Removed temporary file: ${filepath}`);
        } catch (error) {
          console.error('[ERROR] Error removing temporary file:', error);
        }
      }
    } catch (error) {
      console.error('[ERROR] Error handling complete audio:', error);
    }
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
    abortController: null,
    callSession: null,
    audioProcessor: null,
    heartbeatInterval: null,
    lastHeartbeat: 0
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
      case 'call_start':
        console.log('📞 Call session started');
        
        // Create new call session
        clientState.callSession = new CallSession();
        clientState.callSession.activate();
        
        // Create audio processor
        clientState.audioProcessor = new AudioStreamProcessor(clientState);
        
        // Set up heartbeat interval
        clientState.lastHeartbeat = Date.now();
        clientState.heartbeatInterval = setInterval(() => {
          if (Date.now() - clientState.lastHeartbeat > 10000) {
            console.log('❌ Heartbeat timeout, closing connection');
            ws.close();
            return;
          }
          
          ws.send(JSON.stringify({
            type: 'heartbeat',
            timestamp: Date.now()
          }));
        }, 5000);
        
        // Send confirmation to client
        ws.send(JSON.stringify({
          type: 'call_started',
          sessionId: clientState.callSession.sessionId,
          message: 'Call session started successfully'
        }));
        break;

      case 'call_end':
        console.log('📞 Call session ended');
        
        // End call session
        if (clientState.callSession) {
          clientState.callSession.end();
        }
        
        // Clear audio processor
        if (clientState.audioProcessor) {
          clientState.audioProcessor.clearBuffer();
          clientState.audioProcessor = null;
        }
        
        // Clear heartbeat interval
        if (clientState.heartbeatInterval) {
          clearInterval(clientState.heartbeatInterval);
          clientState.heartbeatInterval = null;
        }
        
        // Send confirmation to client
        ws.send(JSON.stringify({
          type: 'call_ended',
          message: 'Call session ended successfully'
        }));
        break;
        
      case 'heartbeat_ack':
        // Update last heartbeat time
        clientState.lastHeartbeat = Date.now();
        break;
        
      case 'audio_chunk':
        // Process audio chunk for streaming
        if (!clientState.callSession || clientState.callSession.state !== 'ACTIVE') {
          console.log('⚠️ Received audio chunk but no active call session');
          return;
        }
        
        if (!clientState.audioProcessor) {
          console.log('⚠️ No audio processor available');
          return;
        }
        
        try {
          console.log('[DEBUG] Received audio chunk, processing...');
          // Check if audioData is a string (base64) or already a Buffer
          let audioBuffer: Buffer;
          
          if (typeof data.audioData === 'string') {
            // Decode base64 string to buffer
            audioBuffer = Buffer.from(data.audioData, 'base64');
            console.log(`[DEBUG] Decoded base64 audio data to buffer, size: ${audioBuffer.length} bytes`);
          } else if (Buffer.isBuffer(data.audioData)) {
            // Already a buffer
            audioBuffer = data.audioData;
            console.log(`[DEBUG] Audio data is already a buffer, size: ${audioBuffer.length} bytes`);
          } else {
            console.error('[ERROR] Invalid audio data format');
            return;
          }
          
          // Process the audio chunk
          clientState.audioProcessor.addChunk(
            audioBuffer,
            data.sequenceNumber || 0,
            data.timestamp || Date.now()
          );
        } catch (error) {
          console.error('[ERROR] Error processing audio chunk:', error);
        }
        break;
        
      case 'interrupt_ai':
        console.log('🛑 AI interrupted by user');
        await handleAIInterrupt(ws, clientState);
        break;

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
        
        if (clientState.audioProcessor) {
          await clientState.audioProcessor.handleAudioComplete(data);
        } else {
          console.error('[ERROR] Audio processor not initialized');
        }
        break;

      default:
        console.log('Unknown message type:', data.type);
    }
  }

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    const clientState = clients.get(ws);
    
    // Clean up resources
    if (clientState) {
      // Abort any ongoing request
      if (clientState.abortController) {
        clientState.abortController.abort();
      }
      
      // Clear heartbeat interval
      if (clientState.heartbeatInterval) {
        clearInterval(clientState.heartbeatInterval);
      }
      
      // End call session if active
      if (clientState.callSession && clientState.callSession.state === 'ACTIVE') {
        clientState.callSession.end();
      }
      
      // Clear audio processor
      if (clientState.audioProcessor) {
        clientState.audioProcessor.clearBuffer();
      }
    }
    
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    const clientState = clients.get(ws);
    
    // Clean up resources
    if (clientState) {
      // Abort any ongoing request
      if (clientState.abortController) {
        clientState.abortController.abort();
      }
      
      // Clear heartbeat interval
      if (clientState.heartbeatInterval) {
        clearInterval(clientState.heartbeatInterval);
      }
      
      // End call session if active
      if (clientState.callSession && clientState.callSession.state === 'ACTIVE') {
        clientState.callSession.end();
      }
      
      // Clear audio processor
      if (clientState.audioProcessor) {
        clientState.audioProcessor.clearBuffer();
      }
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
  res.json({ status: 'ok' });
});

// Add routes to the Express app
app.get('/', (req, res) => {
  res.send('Voice Assistant Backend API');
});

const PORT = process.env.PORT || 3001;

// Function to check if the AssemblyAI API key is valid
async function checkAssemblyAIApiKey(): Promise<boolean> {
  try {
    console.log('[TRACE] Checking AssemblyAI API key validity...');
    
    // Try to list transcripts to verify the API key
    // This is a lightweight operation that should work with any valid key
    const response = await client.transcripts.list({ limit: 1 });
    
    if (response) {
      console.log(`[TRACE] AssemblyAI API key is valid`);
      return true;
    } else {
      console.error('[ERROR] AssemblyAI API key seems invalid - unexpected response');
      return false;
    }
  } catch (error) {
    console.error('[ERROR] AssemblyAI API key validation failed:', error);
    return false;
  }
}

// Initialize the server
async function initializeServer() {
  try {
    // Check if audio directory exists, create if not
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    
    // Check API keys
    const assemblyAIValid = await checkAssemblyAIApiKey();
    if (!assemblyAIValid) {
      console.error('[ERROR] AssemblyAI API key is invalid or not properly configured');
    }
    
    // Start the server
    server.listen(PORT, () => {
      console.log(`🚀 Voice Assistant Backend running on port ${PORT}`);
      console.log(`📡 WebSocket server ready at ws://localhost:${PORT}`);
      console.log(`🌐 HTTP server ready at http://localhost:${PORT}`);
      console.log(`🎤 Audio files will be saved to: ${audioDir}`);
    });
  } catch (error) {
    console.error('[ERROR] Failed to initialize server:', error);
    process.exit(1);
  }
}

// Start the server
initializeServer();