import { StyleSheet, TouchableOpacity, View, Alert } from 'react-native';
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
  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

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
      const ws = new WebSocket('ws://192.168.1.58:3001');
      
      ws.onopen = () => {
        console.log('WebSocket connected to backend');
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Received from backend:', data);
          
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
              setIsProcessing(false);
              if (data.error) {
                Alert.alert('Error', data.message);
              } else {
                Alert.alert('Success', data.message);
              }
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
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);
      sendWebSocketMessage('voice_start');
      console.log('Recording started');
    } catch (error) {
      console.error('Failed to start recording:', error);
      Alert.alert('Error', 'Failed to start recording');
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;

    try {
      setIsProcessing(true);
      sendWebSocketMessage('voice_stop');
      
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      console.log('Recording URI:', uri);
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
          channels: 1
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

  const handleVoiceButtonPress = async () => {
    if (hasPermission === null) {
      return;
    }

    if (hasPermission === false) {
      await requestPermission();
      return;
    }

    if (!isRecording) {
      await startRecording();
    } else {
      await stopRecording();
    }
  };

  return (
    <ThemedView style={styles.container}>
      {/* Header */}
      <ThemedView style={styles.header}>
        <ThemedText style={styles.headerText}>Welcome to</ThemedText>
        <ThemedText style={styles.headerTextBold}>Voice Assistant</ThemedText>
      </ThemedView>
      
      {/* Voice Assistant Button */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity 
          style={[styles.voiceButton, isRecording && styles.voiceButtonRecording]} 
          activeOpacity={0.8}
          onPress={handleVoiceButtonPress}
          disabled={isProcessing}
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
            : isProcessing
            ? 'Processing audio...'
            : isRecording 
            ? 'Recording... Tap to stop' 
            : 'Tap to start voice assistant'
          }
        </ThemedText>
        
        {/* Connection Status */}
        <ThemedText style={[styles.connectionStatus, { color: isConnected ? '#34C759' : '#FF3B30' }]}>
          {isConnected ? '🟢 Connected to backend' : '🔴 Disconnected from backend'}
        </ThemedText>
      </View>
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
  buttonContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
  connectionStatus: {
    marginTop: 10,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
