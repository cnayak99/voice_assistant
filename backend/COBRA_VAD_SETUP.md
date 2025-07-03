# Cobra VAD Integration Setup Guide

## 1. Get Picovoice Access Key

1. Go to [Picovoice Console](https://console.picovoice.ai/)
2. Sign up for a free account
3. Create a new project or use an existing one
4. Copy your Access Key from the dashboard

## 2. Configure Environment Variables

Create a `.env` file in the `backend` directory with:

```env
# Existing keys
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
GROQ_API_KEY=your_groq_api_key_here
GOOGLE_APPLICATION_CREDENTIALS=path/to/your/google-service-account.json

# Picovoice Cobra VAD
PICOVOICE_ACCESS_KEY=your_picovoice_access_key_here

# Server Configuration
PORT=3000
```

## 3. Test the Integration

1. Start the backend server:
   ```bash
   npm run dev
   ```

2. Connect with your frontend and speak into the microphone

3. Check the console logs for VAD output:
   - Look for `[COBRA VAD]` logs if Cobra is working
   - Look for `[VAD] === ENERGY-BASED VAD RESULTS ===` if falling back to energy-based VAD

## 4. What to Expect

### With Cobra VAD (when access key is configured):
```
[COBRA VAD] Successfully initialized Cobra Voice Activity Detection
[COBRA VAD] Sample rate: 16000 Hz
[COBRA VAD] Frame length: 512 samples
[COBRA VAD] Voice probability: 85.2% | Threshold: 50.0% | Voice detected: YES
[COBRA VAD] Processed 3 frames from 1536 samples
[COBRA VAD] Probability: [████████████████████] 85.2%
[COBRA VAD] Threshold:   [██████████|]
[VAD] === COBRA VAD RESULTS ===
[VAD] Voice probability: 85.2%
[VAD] Voice detected: YES
[VAD] Energy (reference): 0.1234
```

### Without Cobra VAD (fallback to energy-based):
```
[COBRA VAD] PICOVOICE_ACCESS_KEY not found in environment variables. Using fallback energy-based VAD.
[VAD] === ENERGY-BASED VAD RESULTS ===
[VAD] Chunk energy: 0.0756 | Threshold: 0.0500 | Speaking: YES
[VAD] Voice confidence: 67.3%
```

## 5. WebSocket Messages

The frontend will receive enhanced VAD status messages:

```json
{
  "type": "vad_status",
  "isSpeaking": true,
  "timestamp": 1641234567890,
  "vadMethod": "cobra",
  "cobra": {
    "voiceProbability": 0.852,
    "hasVoice": true,
    "threshold": 0.852
  },
  "energy": {
    "currentLevel": 0.1234,
    "threshold": 0.05
  }
}
```

## 6. Troubleshooting

- **No Cobra logs**: Check that `PICOVOICE_ACCESS_KEY` is set in your `.env` file
- **Cobra initialization fails**: Verify your access key is valid and you have internet connection
- **Audio format issues**: Cobra expects 16-bit PCM audio - the integration handles conversion automatically
- **Performance issues**: Cobra processes audio in 512-sample frames at 16kHz (32ms chunks) 