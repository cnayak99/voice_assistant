# Voice Assistant Backend

A WebSocket-enabled backend server for the voice assistant application.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

Or build and run in production:
```bash
npm run build
npm start
```

## Features

- **WebSocket Server**: Handles real-time communication with the frontend
- **Voice Commands**: Processes voice start/stop messages
- **Health Check**: HTTP endpoint for monitoring server status
- **CORS Enabled**: Allows cross-origin requests from the frontend

## Endpoints

- `GET /` - Server information
- `GET /health` - Health check with connection status
- `WS /` - WebSocket connection for voice assistant communication

## WebSocket Messages

### From Frontend to Backend:
- `{ "type": "voice_start" }` - Start voice listening
- `{ "type": "voice_stop" }` - Stop voice listening

### From Backend to Frontend:
- `{ "type": "connection_established", "message": "..." }` - Connection confirmed
- `{ "type": "voice_start_ack", "message": "..." }` - Voice start acknowledged
- `{ "type": "voice_stop_ack", "message": "..." }` - Voice stop acknowledged

## Server Port

The server runs on port 3001 by default. You can change this by setting the `PORT` environment variable. 