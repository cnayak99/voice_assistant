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
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

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
      // Connect to the backend WebSocket server using computer's IP address
      const ws = new WebSocket('ws://192.168.1.80:3001');
      
      ws.onopen = () => {
        console.log('WebSocket connected to backend');
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          switch (data.type) {
            case 'connection_established':
              console.log('Backend connection confirmed');
              break;
            case 'voice_start_ack':
              console.log('Backend acknowledged voice start');
              break;
            case 'voice_stop_ack':
              console.log('Backend acknowledged voice stop');
              break;
            case 'audio_received':
              console.log('Backend received audio:', data.message);
              console.log('Response request ID:', data.requestId);
              console.log('Current request ID:', currentRequestId);
              
              // Only process this response if it matches the current request ID
              if (data.requestId && currentRequestId && data.requestId !== currentRequestId) {
                console.log('🚫 Ignoring response from old/cancelled request:', data.requestId);
                return;
              }
              
              setIsProcessing(false);
              setAiState('idle');
              if (data.error) {
                setTranscription('');
                setGroqResponse('');
                Alert.alert('Error', data.message);
              } else {
                if (data.transcription) {
                  setTranscription(data.transcription);
                }
                if (data.response) {
                  setGroqResponse(data.response);
                }
                if (data.speechAudio) {
                  // Only play audio if this is still the current request
                  console.log('✅ Playing audio for current request:', data.requestId);
                  setAiState('speaking');
                  playAudioResponse(data.speechAudio);
                }
                Alert.alert('Success', data.message);
              }
              break;
            case 'ai_interrupted':
              console.log('AI response interrupted');
              setAiState('idle');
              setIsPlayingAudio(false);
              break;
            case 'processing_started':
              console.log('Backend started processing');
              setAiState('processing');
              break;
            default:
              console.log('Unknown message type from backend:', data.type);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket connection closed');
        setIsConnected(false);
        setIsProcessing(false);
        Alert.alert('Connection Lost', 'Lost connection to the voice assistant server. Please try again.');
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
        setIsProcessing(false);
        Alert.alert('Connection Error', 'Failed to connect to the voice assistant server. Please try again.');
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('Error connecting to WebSocket:', error);
      setIsConnected(false);
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

  const startRecording = async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false, // Keep loudspeaker preference
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
      sendWebSocketMessage('start_listening');
      console.log('Recording started - hold to continue');
    } catch (error) {
      console.error('Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording');
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;

    try {
      setIsProcessing(true);
      sendWebSocketMessage('stop_listening');
      
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      console.log('Recording completed, URI:', uri);
      recordingRef.current = null;
      setIsRecording(false);

      if (uri) {
        await sendAudioToBackend(uri);
      }
    } catch (error) {
      console.error('Failed to stop recording:', error);
      setIsProcessing(false);
      Alert.alert('Error', 'Failed to stop recording');
    }
  };

  const sendAudioToBackend = async (audioUri: string) => {
    try {
      console.log('Reading audio file from:', audioUri);
      
      // Generate unique request ID
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setCurrentRequestId(requestId);
      console.log('🎯 Starting new request:', requestId);
      
      // Read the audio file
      const audioData = await FileSystem.readAsStringAsync(audioUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      console.log('Audio data length:', audioData.length);
      console.log('Audio data type:', typeof audioData);

      // Send audio data to backend
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        console.log('WebSocket is open, sending audio data...');
        const message = JSON.stringify({
          type: 'audio_complete',
          audioData: audioData,
          duration: 0,
          format: 'm4a',
          sampleRate: 44100,
          channels: 1,
          requestId: requestId  // Include request ID
        });
        
        console.log('Message type:', typeof message);
        console.log('Message length:', message.length);
        console.log('Message preview:', message.substring(0, 200) + '...');
        
        wsRef.current.send(message);
        console.log('Audio data sent to backend as JSON string');
      } else {
        console.error('WebSocket not connected! State:', wsRef.current?.readyState);
        setIsProcessing(false);
        Alert.alert('Connection Error', 'Lost connection to server. Please try recording again.');
      }
    } catch (error: any) {
      console.error('Failed to send audio to backend:', error);
      setIsProcessing(false);
      Alert.alert('Error', 'Failed to send audio: ' + error.message);
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
  };

  const handleButtonPressOut = async () => {
    if (isRecording) {
      await stopRecording();
    }
  };

  // Function to stop current audio playback
  const stopAudioPlayback = async () => {
    try {
      console.log('Stopping audio playback...');
      // Immediately update states first
      setIsPlayingAudio(false);
      setAiState('idle');
      
      if (soundRef.current) {
        // Stop and unload without awaiting for immediate effect
        soundRef.current.stopAsync();
        soundRef.current.unloadAsync();
        soundRef.current = null;
        console.log('Audio stopped and unloaded successfully');
      }
      console.log('Audio playback stopped');
    } catch (error) {
      console.error('Error stopping audio:', error);
      // Even if there's an error, reset the state
      setIsPlayingAudio(false);
      setAiState('idle');
      soundRef.current = null;
    }
  };

  // Function to play audio response
  const playAudioResponse = async (audioBase64: string) => {
    try {
      setIsPlayingAudio(true);
      console.log('Playing audio response...');
      
      // Set audio mode to use loudspeaker
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false, // Force loudspeaker on Android
      });
      
      // Create a temporary file for the audio
      const audioUri = FileSystem.documentDirectory + 'response_audio.mp3';
      
      // Write base64 audio to file
      await FileSystem.writeAsStringAsync(audioUri, audioBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      
      // Load and play the audio
      const { sound } = await Audio.Sound.createAsync(
        { uri: audioUri },
        { 
          shouldPlay: true,
          volume: 1.0,
          isMuted: false,
        }
      );
      
      soundRef.current = sound;
      
      // Set up playback status update
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setIsPlayingAudio(false);
          setAiState('idle');
          sound.unloadAsync();
          soundRef.current = null;
        }
      });
      
    } catch (error) {
      console.error('Error playing audio:', error);
      setIsPlayingAudio(false);
      setAiState('idle');
      Alert.alert('Audio Error', 'Failed to play audio response');
    }
  };

  return (
    <ThemedView style={styles.container}>
      {/* Header */}
      <ThemedView style={styles.header}>
        <ThemedText style={styles.headerText}>Welcome to</ThemedText>
        <ThemedText style={styles.headerTextBold}>Voice Assistant</ThemedText>
      </ThemedView>
      
      {/* Fixed Button Container */}
      <View style={styles.fixedButtonContainer}>
        <TouchableOpacity 
          style={[styles.voiceButton, isRecording && styles.voiceButtonRecording]} 
          activeOpacity={0.8}
          onPressIn={handleButtonPressIn}
          onPressOut={handleButtonPressOut}
          disabled={isProcessing && aiState !== 'speaking'}
        >
          <View style={[styles.buttonInner, isRecording && styles.buttonInnerRecording]}>
            <Ionicons 
              name={isRecording ? "stop" : "mic"} 
              size={40} 
              color="#FFFFFF" 
            />
          </View>
          <View style={[styles.buttonGlow, isRecording && styles.buttonGlowRecording]} />
        </TouchableOpacity>
        
        {/* Status Text */}
        <ThemedText style={styles.statusText}>
          {hasPermission === null 
            ? 'Checking permissions...' 
            : hasPermission === false 
            ? 'Tap to grant microphone permission' 
            : aiState === 'processing'
            ? 'AI is thinking... (hold to interrupt)'
            : aiState === 'speaking'
            ? 'AI is speaking... (hold to interrupt)'
            : isRecording 
            ? 'Recording... Release to send' 
            : 'Hold to talk to AI assistant'
          }
        </ThemedText>
      </View>
      
      {/* Scrollable Content Container */}
      <ScrollView 
        style={styles.scrollableContent}
        contentContainerStyle={styles.scrollableContentContainer}
        showsVerticalScrollIndicator={true}
        bounces={true}
      >
        {/* Transcription Result */}
        {transcription ? (
          <ThemedView style={styles.resultContainer}>
            <ThemedText style={styles.resultLabel}>You said:</ThemedText>
            <ThemedText style={styles.transcriptionText}>{transcription}</ThemedText>
          </ThemedView>
        ) : null}
        
        {/* Groq Response */}
        {groqResponse ? (
          <ThemedView style={styles.responseContainer}>
            <ThemedText style={styles.resultLabel}>Assistant:</ThemedText>
            <ThemedText style={styles.responseText}>{groqResponse}</ThemedText>
          </ThemedView>
        ) : null}
        
        {/* Connection Status */}
        <ThemedText style={[styles.connectionStatus, { color: isConnected ? '#34C759' : '#FF3B30' }]}>
          {isConnected ? '🟢 Connected to backend' : '🔴 Disconnected from backend'}
        </ThemedText>
        
        {/* Bottom padding to ensure content doesn't get cut off */}
        <View style={styles.bottomPadding} />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: 100,
    paddingBottom: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  headerText: {
    fontSize: 28,
    fontWeight: '300',
    color: '#8E8E93',
    letterSpacing: 2,
    marginBottom: 4,
  },
  headerTextBold: {
    fontSize: 36,
    paddingTop: 10,
    fontWeight: '700',
    color: '#007AFF',
    letterSpacing: 1,
    textShadowColor: 'rgba(0, 122, 255, 0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  fixedButtonContainer: {
    paddingVertical: 20,
    paddingHorizontal: 20,
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  voiceButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  voiceButtonRecording: {
    transform: [{ scale: 1.1 }],
  },
  buttonInner: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  buttonInnerRecording: {
    backgroundColor: '#FF3B30',
    shadowColor: '#FF3B30',
  },
  buttonGlow: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(0, 122, 255, 0.2)',
    zIndex: -1,
  },
  buttonGlowRecording: {
    backgroundColor: 'rgba(255, 59, 48, 0.3)',
  },
  statusText: {
    marginTop: 20,
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  scrollableContent: {
    flex: 1,
  },
  scrollableContentContainer: {
    padding: 20,
    paddingTop: 10,
  },
  connectionStatus: {
    marginTop: 20,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  resultContainer: {
    marginTop: 20,
    padding: 15,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
    width: '100%',
  },
  responseContainer: {
    marginTop: 15,
    padding: 15,
    borderRadius: 10,
    backgroundColor: 'rgba(52, 199, 89, 0.1)',
    width: '100%',
  },
  resultLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    color: '#007AFF',
  },
  transcriptionText: {
    fontSize: 16,
    lineHeight: 24,
    fontStyle: 'italic',
  },
  responseText: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
  },
  bottomPadding: {
    height: 20,
  },
});
