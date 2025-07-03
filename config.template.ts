// Configuration file template for API keys and other settings
// Copy this file to config.ts and add your actual API keys

export const CONFIG = {
  // API Keys
  ASSEMBLYAI_API_KEY: "YOUR_ASSEMBLYAI_API_KEY", // Get free key from https://www.assemblyai.com/dashboard/signup
  GROQ_API_KEY: "YOUR_GROQ_API_KEY", // Replace with your Groq API key
  ELEVENLABS_API_KEY: "YOUR_ELEVENLABS_API_KEY", // Replace with your ElevenLabs API key
  
  // API Endpoints
  GROQ_API_ENDPOINT: "https://api.groq.com/openai/v1/chat/completions",
  ELEVENLABS_API_ENDPOINT: "https://api.elevenlabs.io/v1/text-to-speech",
  
  // Model settings
  DEFAULT_MODEL: "llama3-8b-8192", // You can also use "mixtral-8x7b-32768" or other models
  TEMPERATURE: 0.7,
  MAX_TOKENS: 1024,
  
  // ElevenLabs settings
  ELEVENLABS_VOICE_ID: "21m00Tcm4TlvDq8ikWAM", // Rachel voice
  
  // System prompts
  SYSTEM_PROMPT: "You are a receptionist at a dental clinic. Be resourceful and efficient."
}; 