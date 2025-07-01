import { StyleSheet, TouchableOpacity, View, Alert, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { useState, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system';

import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';

export default function HomeScreen() {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcription, setTranscription] = useState<string>('');
  const [groqResponse, setGroqResponse] = useState<string>('');
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [aiState, setAiState] = useState<'idle' | 'processing' | 'speaking'>('idle');
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  
  // Call session state
  const [callActive, setCallActive] = useState(false);
  const [callSessionId, setCallSessionId] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false); // VAD result
  const [audioLevel, setAudioLevel] = useState(0); // For visualization
  
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const callTimerRef = useRef<number | null>(null);
  const audioChunkIntervalRef = useRef<number | null>(null);
  const sequenceNumberRef = useRef<number>(0);
  const recordingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    checkPermission();
    connectWebSocket();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    try {
      const ws = new WebSocket('ws://192.168.1.80:3001');
      
      ws.onopen = () => {
        console.log('WebSocket connection established');
        setIsConnected(true);
      };

      ws.onmessage = handleWebSocketMessage;
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
      };

      ws.onclose = () => {
        console.log('WebSocket connection closed');
        setIsConnected(false);
        
        // End call session if active
        if (callActive) {
          setCallActive(false);
          setCallSessionId(null);
          
          // Clear call duration timer
          if (callTimerRef.current) {
            clearInterval(callTimerRef.current);
            callTimerRef.current = null;
          }
          
          // Clear audio chunk interval
          if (audioChunkIntervalRef.current) {
            clearInterval(audioChunkIntervalRef.current);
            audioChunkIntervalRef.current = null;
          }
          
          // Stop recording if active
          if (recordingRef.current) {
            recordingRef.current.stopAndUnloadAsync().catch(console.error);
            recordingRef.current = null;
          }
          
          setIsRecording(false);
        }
        
        // Try to reconnect after a delay
        setTimeout(connectWebSocket, 3000);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('Error connecting to WebSocket server:', error);
      setIsConnected(false);
      
      // Try to reconnect after a delay
      setTimeout(connectWebSocket, 3000);
    }
  };

  const sendWebSocketMessage = (type: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({ type });
      wsRef.current.send(message);
      console.log('Sent to backend:', message);
    } else {
      console.log('WebSocket not connected, attempting to reconnect...');
      connectWebSocket();
    }
  };

  const checkPermission = async () => {
    const { status } = await Audio.getPermissionsAsync();
    setHasPermission(status === 'granted');
  };

  const requestPermission = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      setHasPermission(status === 'granted');
      
      if (status !== 'granted') {
        Alert.alert(
          'Permission Required',
          'Microphone permission is required to use the voice assistant. Please enable it in your device settings.',
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Error requesting permission:', error);
      Alert.alert('Error', 'Failed to request microphone permission.');
    }
  };

  // Start recording audio
  const startRecording = async () => {
    try {
      if (!hasPermission) {
        await requestPermission();
        if (!hasPermission) return;
      }
      
      // Set audio mode for recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      
      // Create a new recording with WAV format for better speech recognition
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        isMeteringEnabled: true,
        android: {
          extension: '.wav',
          outputFormat: Audio.AndroidOutputFormat.DEFAULT,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
          sampleRate: 48000, // Higher sample rate for better quality
          numberOfChannels: 1,
          bitRate: 192000, // Higher bitrate for better quality
        },
        ios: {
          extension: '.wav',
          audioQuality: Audio.IOSAudioQuality.MAX,
          sampleRate: 48000, // Higher sample rate for better quality
          numberOfChannels: 1,
          bitRate: 192000, // Higher bitrate for better quality
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {
          mimeType: 'audio/wav',
          bitsPerSecond: 192000, // Higher bitrate for better quality
        }
      });
      
      // Start recording
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
      
      // Generate a unique request ID
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setCurrentRequestId(requestId);
      
      // If AI is currently speaking or processing, interrupt it
      if (aiState !== 'idle') {
        console.log('[TRACE] Interrupting AI because user started recording');
        // Stop current TTS playback
        if (soundRef.current) {
          try {
            await soundRef.current.stopAsync();
            soundRef.current.unloadAsync();
            soundRef.current = null;
          } catch (err) {
            console.error('[ERROR] Error stopping sound:', err);
          }
        }
      }
      
      // Send start_listening message to server
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'start_listening',
          requestId: requestId
        }));
      }
    } catch (error) {
      console.error('[ERROR] Failed to start recording:', error);
      setIsRecording(false);
      Alert.alert('Error', 'Failed to start recording');
    }
  };

  // Stop recording and send audio
  const stopRecording = async () => {
    try {
      if (!recordingRef.current) {
        console.log('[TRACE] No active recording to stop');
        setIsRecording(false);
        return;
      }
      
      console.log('[TRACE] Stopping recording');
      setIsRecording(false);
      
      // Send stop_listening message to server
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'stop_listening',
          requestId: currentRequestId
        }));
      }
      
      // Stop the recording
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      
      if (!uri) {
        console.error('[ERROR] No recording URI available');
        return;
      }
      
      console.log('[TRACE] Recording saved to:', uri);
      
      // Read the audio file
      const fileInfo = await FileSystem.getInfoAsync(uri);
      const fileSize = fileInfo.exists ? fileInfo.size || 0 : 0;
      console.log('[TRACE] Audio file size:', fileSize, 'bytes');
      
      const audioData = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      console.log('[TRACE] Audio data encoded as base64, length:', audioData.length);

      // Send the audio data to the server
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        setIsProcessing(true);
        setAiState('processing');
        
        // Get audio details from the recording
        const { sound, status } = await Audio.Sound.createAsync({ uri });
        const duration = status.isLoaded ? status.durationMillis || 0 : 0;
        
        const message = JSON.stringify({
          type: 'audio_complete',
          audioData: audioData,
          duration: duration,
          format: 'wav',
          sampleRate: 48000,
          channels: 1,
          bitRate: 192000,
          requestId: currentRequestId
        });
        
        wsRef.current.send(message);
        console.log('[TRACE] Sent audio data to server, request ID:', currentRequestId);
      } else {
        console.error('[ERROR] WebSocket not connected');
        setIsProcessing(false);
        setAiState('idle');
      }
      
      // Clean up
      recordingRef.current = null;
      
      // Delete the temporary file
      try {
        await FileSystem.deleteAsync(uri);
        console.log('[TRACE] Deleted temporary audio file');
      } catch (deleteError) {
        console.error('[ERROR] Failed to delete temporary audio file:', deleteError);
      }
    } catch (error) {
      console.error('[ERROR] Failed to stop recording:', error);
      setIsProcessing(false);
      setAiState('idle');
      Alert.alert('Error', 'Failed to process audio');
    }
  };

  // Hold-to-talk: Press down to start, release to stop
  const handleButtonPressIn = async () => {
    if (hasPermission === null) {
      return;
    }

    if (hasPermission === false) {
      await requestPermission();
      return;
    }

    // IMMEDIATELY stop any playing audio - do this FIRST and synchronously
    if (soundRef.current) {
      try {
        soundRef.current.stopAsync(); // Don't await - stop immediately
        soundRef.current.unloadAsync(); // Don't await - unload immediately
        soundRef.current = null;
        console.log('Audio stopped immediately on button press');
      } catch (error) {
        console.error('Error stopping audio immediately:', error);
      }
    }

    // If AI is speaking or processing, interrupt it
    if (aiState === 'speaking') {
      console.log('Interrupting AI speech');
      // Immediately update state to prevent any race conditions
      setAiState('idle');
      setIsPlayingAudio(false);
      setCurrentRequestId(null); // Clear current request ID
      // Tell backend to interrupt
      sendWebSocketMessage('interrupt_ai');
    } else if (aiState === 'processing') {
      console.log('Interrupting AI processing');
      // Tell backend to cancel processing
      sendWebSocketMessage('cancel_processing');
      // Immediately update state
      setIsProcessing(false);
      setAiState('idle');
      setCurrentRequestId(null); // Clear current request ID
    }

    // Start recording (this will now happen after interrupt cleanup)
      await startRecording();
    
    // Set a maximum recording time of 20 seconds
    recordingTimeoutRef.current = setTimeout(() => {
      if (isRecording) {
        console.log('[TRACE] Maximum recording time reached (20s), stopping automatically');
        stopRecording();
      }
    }, 20000) as unknown as number;
  };

  const handleButtonPressOut = async () => {
    // Clear the maximum recording timeout
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    
    if (isRecording) {
      await stopRecording();
    }
  };

  // Stop any playing audio
  const stopAudioPlayback = async () => {
    try {
      console.log('[TRACE] Stopping audio playback');
      
      if (soundRef.current) {
        const status = await soundRef.current.getStatusAsync();
        
        if (status.isLoaded) {
          if (status.isPlaying) {
            console.log('[TRACE] Stopping active playback');
            await soundRef.current.stopAsync();
          }
          
          console.log('[TRACE] Unloading sound');
          await soundRef.current.unloadAsync();
        }
        
        soundRef.current = null;
      }
      
      setIsPlayingAudio(false);
      console.log('[TRACE] Audio playback stopped and cleaned up');
    } catch (error) {
      console.error('[ERROR] Error stopping audio playback:', error);
    }
  };

  // Play audio response from base64 string
  const playAudioResponse = async (base64Audio: string) => {
    try {
      console.log('[TRACE] Starting audio playback, base64 length:', base64Audio.length);
      
      // Stop any currently playing audio first
      await stopAudioPlayback();
      
      // Create a temporary file URI for the audio
      const fileUri = FileSystem.documentDirectory + 'temp_audio.mp3';
      console.log('[TRACE] Writing audio to temporary file:', fileUri);
      
      // Write the base64 audio data to a file
      await FileSystem.writeAsStringAsync(fileUri, base64Audio, {
        encoding: FileSystem.EncodingType.Base64,
      });
      console.log('[TRACE] Audio file written successfully');
      
      // Create a new sound object
      console.log('[TRACE] Loading sound from file');
      const { sound } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: true, volume: 1.0 }
      );
      
      // Store the sound reference
      soundRef.current = sound;
      setIsPlayingAudio(true);
      console.log('[TRACE] Audio playback started');
      
      // Set up audio mode for playback through loudspeaker
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      console.log('[TRACE] Audio mode set for loudspeaker playback');
      
      // Listen for playback status updates
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded) {
          if (status.didJustFinish) {
            console.log('[TRACE] Audio playback finished');
            setIsPlayingAudio(false);
            setAiState('idle');
            sound.unloadAsync().catch(console.error);
            soundRef.current = null;
          }
        } else if (status.error) {
          console.error('[ERROR] Audio playback error:', status.error);
          setIsPlayingAudio(false);
          setAiState('idle');
        }
      });
    } catch (error) {
      console.error('[ERROR] Failed to play audio response:', error);
      setIsPlayingAudio(false);
      setAiState('idle');
      Alert.alert('Audio Error', 'Failed to play the voice response');
    }
  };

  // Start a call session
  const startCallSession = async () => {
    try {
      if (!hasPermission) {
        await requestPermission();
        if (!hasPermission) {
          Alert.alert('Permission Required', 'Microphone permission is needed for call sessions.');
          return;
        }
      }
      
      if (!isConnected) {
        Alert.alert('Connection Error', 'Not connected to server. Please check your connection and try again.');
        return;
      }
      
      // Send call_start message to server
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        // Set call active state first to prevent multiple starts
        setCallActive(true);
        
        wsRef.current.send(JSON.stringify({
          type: 'call_start'
        }));
        
        console.log('Call session start request sent to server');
        
        // Start call duration timer
        callTimerRef.current = setInterval(() => {
          setCallDuration(prev => prev + 1);
        }, 1000) as unknown as number;
        
        // Wait a moment before starting recording to ensure server has initialized the session
        setTimeout(async () => {
          try {
            await startContinuousRecording();
          } catch (recordingError) {
            console.error('Failed to start recording after call session start:', recordingError);
            Alert.alert('Recording Error', 'Failed to start audio recording. Please end the call and try again.');
          }
        }, 500);
      } else {
        setCallActive(false);
        console.error('WebSocket not connected!');
        Alert.alert('Connection Error', 'Not connected to server. Please try again.');
      }
    } catch (error) {
      setCallActive(false);
      console.error('Failed to start call session:', error);
      Alert.alert('Error', 'Failed to start call session');
    }
  };
  
  // End a call session
  const endCallSession = async () => {
    try {
      console.log('Ending call session...');
      
      // Stop continuous recording first
      await stopContinuousRecording();
      
      // Send call_end message to server
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'call_end'
        }));
        console.log('Call end request sent to server');
      } else {
        console.warn('WebSocket not connected, cannot send call_end message');
      }
    } catch (error) {
      console.error('Error during call end:', error);
    } finally {
      // Always reset call state regardless of errors
      setCallActive(false);
      setCallSessionId(null);
      
      // Clear call duration timer
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
      
      // Reset call duration
      setCallDuration(0);
      
      console.log('Call session ended and state reset');
    }
  };
  
  // Start continuous audio recording
  const startContinuousRecording = async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      
      // Create and prepare recording with WAV format for better compatibility
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        isMeteringEnabled: true,
        android: {
          extension: '.wav',
          outputFormat: Audio.AndroidOutputFormat.DEFAULT,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
          sampleRate: 48000, // Higher sample rate for better quality
          numberOfChannels: 1,
          bitRate: 192000, // Higher bitrate for better quality
        },
        ios: {
          extension: '.wav',
          audioQuality: Audio.IOSAudioQuality.MAX,
          sampleRate: 48000, // Higher sample rate for better quality
          numberOfChannels: 1,
          bitRate: 192000, // Higher bitrate for better quality
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {
          mimeType: 'audio/wav',
          bitsPerSecond: 192000, // Higher bitrate for better quality
        }
      });
      
      // Start recording
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
      
      // Reset sequence number
      sequenceNumberRef.current = 0;
      
      // Set up interval to get and send audio chunks
      audioChunkIntervalRef.current = setInterval(async () => {
        if (recordingRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            const currentRecording = recordingRef.current;
            const status = await currentRecording.getStatusAsync();
            
            if (status.canRecord) {
              // Stop current recording and get its URI
              await currentRecording.stopAndUnloadAsync();
              const uri = currentRecording.getURI();
              
              // Clear the reference before creating a new recording
              recordingRef.current = null;
              
              if (uri) {
                // Process and send the audio chunk
                await sendAudioChunk(uri);
              }
              
              // Create a new recording after the previous one is fully unloaded
              const nextRecording = new Audio.Recording();
              // Use WAV format for better compatibility with speech recognition
              await nextRecording.prepareToRecordAsync({
                isMeteringEnabled: true,
                android: {
                  extension: '.wav',
                  outputFormat: Audio.AndroidOutputFormat.DEFAULT,
                  audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
                  sampleRate: 48000, // Higher sample rate for better quality
                  numberOfChannels: 1,
                  bitRate: 192000, // Higher bitrate for better quality
                },
                ios: {
                  extension: '.wav',
                  audioQuality: Audio.IOSAudioQuality.MAX,
                  sampleRate: 48000, // Higher sample rate for better quality
                  numberOfChannels: 1,
                  bitRate: 192000, // Higher bitrate for better quality
                  linearPCMBitDepth: 16,
                  linearPCMIsBigEndian: false,
                  linearPCMIsFloat: false,
                },
                web: {
                  mimeType: 'audio/wav',
                  bitsPerSecond: 192000, // Higher bitrate for better quality
                }
              });
              await nextRecording.startAsync();
              recordingRef.current = nextRecording;
            }
          } catch (error) {
            console.error('[ERROR] Error during continuous recording:', error);
            // Wait a bit before trying again to avoid rapid error loops
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Try to reset the recording state
            try {
              if (recordingRef.current) {
                await recordingRef.current.stopAndUnloadAsync();
                recordingRef.current = null;
              }
              
              // Create a fresh recording with WAV format
              const newRecording = new Audio.Recording();
              await newRecording.prepareToRecordAsync({
                isMeteringEnabled: true,
                android: {
                  extension: '.wav',
                  outputFormat: Audio.AndroidOutputFormat.DEFAULT,
                  audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
                  sampleRate: 48000, // Higher sample rate for better quality
                  numberOfChannels: 1,
                  bitRate: 192000, // Higher bitrate for better quality
                },
                ios: {
                  extension: '.wav',
                  audioQuality: Audio.IOSAudioQuality.MAX,
                  sampleRate: 48000, // Higher sample rate for better quality
                  numberOfChannels: 1,
                  bitRate: 192000, // Higher bitrate for better quality
                  linearPCMBitDepth: 16,
                  linearPCMIsBigEndian: false,
                  linearPCMIsFloat: false,
                },
                web: {
                  mimeType: 'audio/wav',
                  bitsPerSecond: 192000, // Higher bitrate for better quality
                }
              });
              await newRecording.startAsync();
              recordingRef.current = newRecording;
            } catch (resetError) {
              console.error('[ERROR] Failed to reset recording:', resetError);
            }
          }
        }
      }, 2000) as unknown as number; // Send chunks every 2 seconds for longer statements
    } catch (error) {
      console.error('[ERROR] Failed to start continuous recording:', error);
      Alert.alert('Error', 'Failed to start recording');
    }
  };
  
  // Stop continuous recording
  const stopContinuousRecording = async () => {
    try {
      // Clear audio chunk interval first to prevent new recordings from being created
      if (audioChunkIntervalRef.current) {
        clearInterval(audioChunkIntervalRef.current);
        audioChunkIntervalRef.current = null;
      }
      
      // Stop recording if active
      if (recordingRef.current) {
        try {
          const status = await recordingRef.current.getStatusAsync();
          if (status.isRecording || status.isDoneRecording) {
            await recordingRef.current.stopAndUnloadAsync();
          }
        } catch (error) {
          console.error('Error stopping recording:', error);
        } finally {
          recordingRef.current = null;
        }
      }
      
      setIsRecording(false);
      console.log('Continuous recording stopped successfully');
    } catch (error) {
      console.error('Failed to stop continuous recording:', error);
    }
  };
  
  // Send audio chunk to server
  const sendAudioChunk = async (audioUri: string) => {
    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('[ERROR] WebSocket not connected for audio chunk');
        return;
      }
      
      // Read audio data as base64
      const audioData = await FileSystem.readAsStringAsync(audioUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      
      // Increment sequence number
      const seqNum = sequenceNumberRef.current++;
      
      // Send audio chunk to server
      const message = JSON.stringify({
        type: 'audio_chunk',
        audioData: audioData,
        sequenceNumber: seqNum,
        timestamp: Date.now(),
        format: 'wav',
        sampleRate: 48000,
        channels: 1,
        bitRate: 192000
      });
      
      wsRef.current.send(message);
      console.log(`[TRACE] Sent audio chunk #${seqNum}, size: ${audioData.length} bytes`);
      
      // Delete the temporary file
      try {
        await FileSystem.deleteAsync(audioUri);
      } catch (deleteError) {
        console.error('[ERROR] Failed to delete temporary audio chunk file:', deleteError);
      }
    } catch (error) {
      console.error('[ERROR] Error sending audio chunk:', error);
    }
  };

  // Handle WebSocket messages
  const handleWebSocketMessage = (event: WebSocketMessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Received message type:', data.type);

      switch (data.type) {
        case 'call_started':
          console.log('Call session started:', data.sessionId);
          setCallSessionId(data.sessionId);
          break;
          
        case 'call_ended':
          console.log('Call session ended');
          setCallActive(false);
          setCallSessionId(null);
          break;
          
        case 'heartbeat':
          // Send heartbeat acknowledgment
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'heartbeat_ack',
              timestamp: Date.now()
            }));
          }
          break;
          
        case 'vad_status':
          // Update VAD status
          setIsSpeaking(data.isSpeaking);
          // Update audio level if provided (normalize between 0-1)
          if (data.audioLevel !== undefined) {
            // Apply some smoothing and scaling to make the visualization more responsive
            const normalizedLevel = Math.min(1, Math.max(0, data.audioLevel * 20));
            setAudioLevel(normalizedLevel);
          }
          break;
          
        case 'stream_response':
          // Handle streaming response
          setTranscription(data.transcription);
          setGroqResponse(data.response);
          
          // Play the speech audio
          if (data.speechAudio) {
            playAudioResponse(data.speechAudio);
          }
          break;

        case 'listening_started':
          console.log('Listening started');
          break;

        case 'listening_stopped':
          console.log('Listening stopped');
          break;

        case 'processing_started':
          // Handle processing started notification
          console.log('Processing started:', data.message);
          
          // Update UI to show processing state
          if (callActive) {
            // Only show processing indicator during call sessions
            setAiState('processing');
          }
          break;

        case 'ai_interrupted':
          console.log('AI was interrupted');
          stopAudioPlayback();
          setAiState('idle');
          break;

        case 'audio_response':
          console.log('Audio response received');
          
          if (data.error) {
            console.error('Error:', data.message);
            Alert.alert('Error', data.message);
            setAiState('idle');
            return;
          }
          
          // Only update if this is the current request
          if (currentRequestId === data.requestId || !currentRequestId) {
            setTranscription(data.transcription);
            setGroqResponse(data.response);
            setIsProcessing(false);
            
            // Play the speech audio
            if (data.speechAudio) {
              setAiState('speaking');
              playAudioResponse(data.speechAudio);
            } else {
              setAiState('idle');
            }
          }
          break;

        case 'stream_error':
          // Handle streaming error
          console.error('Streaming error:', data.message);
          
          // Show error to user but don't end the call
          Alert.alert('Processing Error', data.message, [
            { text: 'Continue', style: 'default' },
            { 
              text: 'End Call', 
              style: 'destructive',
              onPress: endCallSession
            }
          ]);
          break;

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  };

  // Format call duration in MM:SS format
  const formatCallDuration = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Clean up resources when component unmounts
  useEffect(() => {
    return () => {
      // Close WebSocket connection
      if (wsRef.current) {
        wsRef.current.close();
      }
      
      // Stop recording if active
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(console.error);
      }
      
      // Stop audio playback if active
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(console.error);
      }
      
      // Clear call duration timer
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
      
      // Clear audio chunk interval
      if (audioChunkIntervalRef.current) {
        clearInterval(audioChunkIntervalRef.current);
      }
    };
  }, []);

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent}>
      <ThemedView style={styles.header}>
          <ThemedText style={styles.title}>Voice Assistant</ThemedText>
          <ThemedView style={styles.connectionStatus}>
            <ThemedView style={[styles.statusDot, { backgroundColor: isConnected ? '#4CAF50' : '#F44336' }]} />
            <ThemedText style={styles.statusText}>{isConnected ? 'Connected' : 'Disconnected'}</ThemedText>
          </ThemedView>
      </ThemedView>
        
        {/* Call Session Info */}
        {callActive && (
          <ThemedView style={styles.callSessionInfo}>
            <ThemedText style={styles.callSessionText}>
              Call Active: {formatCallDuration(callDuration)}
        </ThemedText>
            {isSpeaking && (
              <ThemedText style={styles.speakingIndicator}>Speaking...</ThemedText>
            )}
            <ThemedView style={styles.audioLevelContainer}>
              <ThemedView 
                style={[
                  styles.audioLevelBar, 
                  { width: `${Math.min(100, audioLevel * 100)}%` }
                ]} 
              />
            </ThemedView>
          </ThemedView>
        )}

        <ThemedView style={styles.transcriptionContainer}>
          <ThemedText style={styles.label}>You said:</ThemedText>
          <ThemedText style={styles.transcription}>{transcription || 'Waiting for your voice...'}</ThemedText>
        </ThemedView>

          <ThemedView style={styles.responseContainer}>
          <ThemedText style={styles.label}>Assistant:</ThemedText>
          <ThemedText style={styles.response}>{groqResponse || 'I\'ll respond here when you speak.'}</ThemedText>
        </ThemedView>

        <ThemedView style={styles.statusContainer}>
          <ThemedText style={styles.statusMessage}>
            {aiState === 'idle' && 'Ready for your voice'}
            {aiState === 'processing' && 'AI is thinking...'}
            {aiState === 'speaking' && 'AI is speaking...'}
            {isRecording && ' (Recording...)'}
          </ThemedText>
          </ThemedView>
      </ScrollView>

      <ThemedView style={styles.controlsContainer}>
        {/* Call Session Controls */}
        {!callActive ? (
          <TouchableOpacity
            style={[styles.callButton, styles.startCallButton]}
            onPress={startCallSession}
            disabled={!isConnected || !hasPermission}
          >
            <ThemedText style={styles.callButtonText}>Start Call</ThemedText>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.callButton, styles.endCallButton]}
            onPress={endCallSession}
          >
            <ThemedText style={styles.callButtonText}>End Call</ThemedText>
          </TouchableOpacity>
        )}

        {/* Push-to-Talk Button */}
        <TouchableOpacity
          style={[
            styles.recordButton,
            isRecording && styles.recordingButton,
            !isConnected && styles.disabledButton,
            !hasPermission && styles.disabledButton
          ]}
          onPressIn={handleButtonPressIn}
          onPressOut={handleButtonPressOut}
          disabled={!isConnected || !hasPermission}
        >
          <ThemedText style={styles.recordButtonText}>
            {isRecording ? 'Release to Send' : 'Hold to Talk'}
        </ThemedText>
        </TouchableOpacity>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingTop: 10,
  },
  header: {
    paddingTop: 100,
    paddingBottom: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '300',
    color: '#8E8E93',
    letterSpacing: 2,
    marginBottom: 4,
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  statusText: {
    fontSize: 16,
    color: '#8E8E93',
  },
  callSessionInfo: {
    marginTop: 20,
    padding: 15,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    width: '100%',
  },
  callSessionText: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    color: '#007AFF',
  },
  speakingIndicator: {
    fontSize: 16,
    fontWeight: '500',
    color: '#007AFF',
  },
  audioLevelContainer: {
    marginTop: 10,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
  },
  audioLevelBar: {
    height: '100%',
    borderRadius: 10,
    backgroundColor: '#007AFF',
  },
  transcriptionContainer: {
    marginTop: 20,
    padding: 15,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    width: '100%',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    color: '#007AFF',
  },
  transcription: {
    fontSize: 16,
    lineHeight: 24,
    fontStyle: 'italic',
  },
  responseContainer: {
    marginTop: 15,
    padding: 15,
    borderRadius: 10,
    backgroundColor: 'rgba(52, 199, 89, 0.1)',
    width: '100%',
  },
  response: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
  },
  statusContainer: {
    marginTop: 20,
    padding: 15,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    width: '100%',
  },
  statusMessage: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
  },
  controlsContainer: {
    padding: 20,
    paddingTop: 10,
    alignItems: 'center',
  },
  callButton: {
    width: 200,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  startCallButton: {
    backgroundColor: '#007AFF',
  },
  endCallButton: {
    backgroundColor: '#FF3B30',
  },
  callButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  recordButton: {
    width: 200,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#007AFF',
  },
  recordingButton: {
    backgroundColor: '#FF3B30',
  },
  disabledButton: {
    backgroundColor: '#CCCCCC',
  },
  recordButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
