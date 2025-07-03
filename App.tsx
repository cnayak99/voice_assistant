import React from 'react';
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, TouchableOpacity, PermissionsAndroid, View } from 'react-native';

import { ThemedText } from './components/ThemedText';
import { ThemedView } from './components/ThemedView';
import { IconSymbol } from './components/ui/IconSymbol';
import { useColorScheme } from './hooks/useColorScheme';
import { Colors } from './constants/Colors';
import { AIAssistant } from './services/AIAssistant';

export default function App() {
  const colorScheme = useColorScheme();
  const [aiAssistant, setAiAssistant] = useState<AIAssistant | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [finalTranscripts, setFinalTranscripts] = useState<string[]>([]);

  useEffect(() => {
    console.log('🚀 App initialized for real-time WebSocket communication');
    
    // Initialize AI Assistant with transcript callback
    const assistant = new AIAssistant((transcript: string, isFinal: boolean) => {
      console.log(`📝 Transcript update: "${transcript}" (Final: ${isFinal})`);
      
      if (isFinal) {
        // Add to final transcripts and clear current
        setFinalTranscripts(prev => [...prev, transcript]);
        setCurrentTranscript('');
      } else {
        // Update current partial transcript
        setCurrentTranscript(transcript);
      }
    });
    
    setAiAssistant(assistant);
    
    // Check initial permission status
    checkMicrophonePermission().then(permission => {
      setHasPermission(permission);
      console.log(`🎤 Initial microphone permission: ${permission}`);
    });
  }, []);

  const checkMicrophonePermission = async () => {
    console.log('🔍 Checking microphone permission...');
    
    if (Platform.OS === 'android') {
      try {
        const result = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
        );
        console.log(`🔍 Android permission check result: ${result}`);
        return result;
      } catch (error) {
        console.error('❌ Error checking Android permission:', error);
        return false;
      }
    } else if (Platform.OS === 'ios') {
      // For iOS, we'll assume permission check happens in the native layer
      return true;
    } else {
      // Web platform
      console.log('🌐 Running on web platform - permission will be requested by browser');
      return true;
    }
  };

  const handlePress = async () => {
    console.log('🔘 Button pressed');
    
    // Check current permission status
    const currentPermission = await checkMicrophonePermission();
    
    if (!currentPermission) {
      // Request permission first
      try {
        console.log('📱 Requesting microphone permission...');
        
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: 'Audio Recording Permission',
              message: 'This app needs access to your microphone for voice recording and transcription.',
              buttonNeutral: 'Ask Me Later',
              buttonNegative: 'Cancel',
              buttonPositive: 'OK',
            }
          );
          const permissionGranted = granted === PermissionsAndroid.RESULTS.GRANTED;
          setHasPermission(permissionGranted);
          
          console.log('📱 Permission request result:', granted);
          
          if (!permissionGranted) {
            Alert.alert(
              'Permission Required',
              'This app needs access to your microphone.',
              [
                { 
                  text: 'Cancel', 
                  style: 'cancel' 
                },
                { 
                  text: 'Settings', 
                  onPress: () => {
                    Linking.openSettings();
                  }
                }
              ]
            );
            return;
          }
        } else {
          // For iOS and web, permission will be handled by the AI Assistant
          setHasPermission(true);
        }
      } catch (error) {
        console.error('❌ Error requesting microphone permission:', error);
        setHasPermission(false);
        return;
      }
    }

    // Toggle transcription
    if (isTranscribing) {
      // Stop transcription
      if (aiAssistant) {
        await aiAssistant.stopTranscription();
      }
      setIsTranscribing(false);
      console.log('⏹️ Transcription stopped');
    } else {
      // Start transcription
      if (aiAssistant) {
        const success = await aiAssistant.startTranscription();
        if (success) {
          setIsTranscribing(true);
          console.log('▶️ Transcription started');
        } else {
          Alert.alert('Error', 'Failed to start transcription. Check your AssemblyAI API key.');
        }
      }
    }
  };

  const getButtonColor = () => {
    if (hasPermission === null) return '#9E9E9E'; // Gray when unknown
    if (hasPermission === false) return '#E53935'; // Red when denied
    if (isTranscribing) return '#E53935'; // Red when actively transcribing
    return Colors[colorScheme ?? 'light'].tint; // Theme color when ready
  };

  const getStatusText = () => {
    if (hasPermission === null) return 'Permission status unknown';
    if (hasPermission === false) return 'Microphone permission denied';
    if (isTranscribing) return 'Listening and transcribing...';
    return 'Ready to start transcription';
  };

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.header}>
        <ThemedText type="title">Voice Assistant</ThemedText>
        <ThemedText style={styles.statusText}>
          Permission Status: {getStatusText()}
        </ThemedText>
      </ThemedView>
      
      <ThemedView style={styles.micContainer}>
        <View style={styles.pulseCircle} />
        <View>
          <TouchableOpacity
            style={[
              styles.micButton,
              { backgroundColor: getButtonColor() }
            ]}
            onPress={handlePress}
            activeOpacity={0.8}
          >
            <IconSymbol 
              name="microphone" 
              size={32} 
              color="#FFFFFF"
            />
          </TouchableOpacity>
        </View>
        
        <ThemedText style={styles.instructionText}>
          {isTranscribing ? 'Tap to stop transcription' : 'Tap to start transcription'}
        </ThemedText>
        
        {hasPermission === false && (
          <ThemedText style={styles.permissionText}>
            Microphone access needed - check console for details
          </ThemedText>
        )}
        
        {Platform.OS === 'web' && (
          <ThemedText style={styles.webInfoText}>
            Web version: Ensure you're on HTTPS or localhost for microphone access
          </ThemedText>
        )}
      </ThemedView>

      {/* Transcription Display */}
      <ThemedView style={styles.transcriptionContainer}>
        <ThemedText style={styles.transcriptionTitle}>Live Transcription:</ThemedText>
        
        {currentTranscript && (
          <ThemedText style={styles.partialTranscript}>
            {currentTranscript}
          </ThemedText>
        )}
        
        {finalTranscripts.map((transcript, index) => (
          <ThemedText key={index} style={styles.finalTranscript}>
            • {transcript}
          </ThemedText>
        ))}
        
        {!isTranscribing && finalTranscripts.length === 0 && (
          <ThemedText style={styles.placeholderText}>
            Transcribed text will appear here...
          </ThemedText>
        )}
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 50,
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
    paddingHorizontal: 20,
  },
  statusText: {
    marginTop: 10,
    fontSize: 14,
    opacity: 0.7,
    textAlign: 'center',
  },
  micContainer: {
    alignItems: 'center',
    marginBottom: 40,
    position: 'relative',
  },
  pulseCircle: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.light.tint,
    opacity: 0.2,
  },
  micButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  instructionText: {
    marginTop: 20,
    fontSize: 16,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  permissionText: {
    marginTop: 10,
    fontSize: 14,
    color: '#E53935',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  webInfoText: {
    marginTop: 10,
    fontSize: 12,
    opacity: 0.7,
    textAlign: 'center',
    paddingHorizontal: 20,
    fontStyle: 'italic',
  },
  transcriptionContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  transcriptionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  partialTranscript: {
    fontSize: 16,
    marginBottom: 10,
    opacity: 0.7,
    fontStyle: 'italic',
  },
  finalTranscript: {
    fontSize: 16,
    marginBottom: 8,
    lineHeight: 24,
  },
  placeholderText: {
    fontSize: 14,
    opacity: 0.5,
    textAlign: 'center',
    marginTop: 20,
    fontStyle: 'italic',
  },
}); 