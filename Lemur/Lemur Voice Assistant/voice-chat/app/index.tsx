import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useConversation } from '@elevenlabs/react';
import { Audio } from 'expo-av';
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, TouchableOpacity } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming
} from 'react-native-reanimated';

// Helper function to setup navigator mocks
const setupNavigatorMocks = () => {
  console.log('Setting up navigator mocks...');
  
  if (Platform.OS !== 'web') {
    // Mock navigator for non-web platforms
    if (typeof global !== 'undefined' && !global.navigator) {
      // @ts-ignore
      global.navigator = {
        // @ts-ignore
        mediaDevices: {
          // @ts-ignore
          getUserMedia: async (constraints: any) => {
            console.log('Mock getUserMedia called with constraints:', constraints);
            
            // Check if we have audio permission using Expo's Audio API
            const { status } = await Audio.getPermissionsAsync();
            if (status !== 'granted') {
              throw new Error('Microphone permission not granted');
            }
            
            // Return a mock MediaStream object
            // @ts-ignore
            return {
              getTracks: () => [{
                stop: () => console.log('Mock track stopped')
              }],
              getAudioTracks: () => [{
                enabled: true,
                id: 'mock-audio-track',
                label: 'Mock Microphone',
                stop: () => console.log('Mock audio track stopped')
              }],
              getVideoTracks: () => [],
              active: true,
              id: 'mock-stream-id',
              onaddtrack: null,
              onremovetrack: null,
              addTrack: () => {},
              removeTrack: () => {},
              getTrackById: () => null,
              clone: () => ({}),
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false
            };
          }
        }
      };
    }
  } else {
    // For web, enhance existing navigator
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      console.log('Setting up web navigator enhancements...');
      
      // Wrap getUserMedia if it exists
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        console.log('Using real browser mediaDevices API');
        
        const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints) => {
          try {
            return await originalGetUserMedia(constraints);
          } catch (error) {
            console.error('Browser getUserMedia error:', error);
            throw error;
          }
        };
      }
      
      // Setup WebSocket wrapper
      if (typeof WebSocket !== 'undefined') {
        console.log('Setting up WebSocket wrapper...');
        
        const originalWebSocket = window.WebSocket;
        // @ts-ignore
        window.WebSocket = function(url, protocols) {
          const ws = new originalWebSocket(url, protocols);
          
          // Add custom error handling
          const originalSend = ws.send;
          ws.send = function(data: string | ArrayBuffer | Blob | ArrayBufferView) {
            try {
              if (ws.readyState === ws.OPEN) {
                return originalSend.call(ws, data);
              } else {
                console.warn(`WebSocket not in OPEN state (${ws.readyState}), message not sent`);
                return false;
              }
            } catch (e) {
              console.error('WebSocket send error:', e);
              return false;
            }
          };
          
          // Add event listeners for debugging
          ws.addEventListener('close', (event) => {
            console.log(`WebSocket closed: code=${event.code}, reason=${event.reason}`);
          });
          
          ws.addEventListener('error', (event) => {
            console.error('WebSocket error:', event);
          });
          
          return ws;
        };
        
        // Copy over static properties
        for (const prop in originalWebSocket) {
          // @ts-ignore
          window.WebSocket[prop] = originalWebSocket[prop];
        }
      }
    }
  }
};

export default function HomeScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>("");
  const [isNavigatorSetup, setIsNavigatorSetup] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [isListening, setIsListening] = useState(false);
  
  // Fallback function when ElevenLabs integration fails - defined early to be used in callbacks
  const useFallbackVoiceAssistant = () => {
    console.log('Using fallback voice assistant');
    
    // Clear any previous error messages and set fallback mode
    setErrorMessage("Using simplified voice assistant mode");
    
    // Add initial messages
    setMessages(currentMessages => [
      ...currentMessages,
      "I'm using a simplified mode due to technical limitations.",
      "What can I help you with today?"
    ]);
    
    // Simulate a voice assistant with predefined responses
    setTimeout(() => {
      setMessages(currentMessages => [
        ...currentMessages,
        "I can help with basic information and tasks."
      ]);
      
      // After a short delay, update the status message
      setTimeout(() => {
        setErrorMessage("Simplified mode active - ElevenLabs integration disabled");
      }, 1000);
    }, 2000);
    
    // Stop the listening animation if it's active
    if (isListening) {
      // Will be defined below
      pulseAnimation.value = 1;
      setIsListening(false);
    }
  };
  
  const conversation = useConversation({
    onConnect: () => {
      console.log("Connected to ElevenLabs");
      setErrorMessage(null);
      setMessages(currentMessages => [...currentMessages, 'Connected to voice assistant']);
    },
    onDisconnect: () => {
      console.log("Disconnected from ElevenLabs");
      // Only show disconnect message if we're not intentionally ending the conversation
      if (isListening && errorMessage !== "Using simplified voice assistant mode" && 
          errorMessage !== "Simplified mode active - ElevenLabs integration disabled") {
        console.log("Unexpected disconnection during active conversation");
      } else {
        console.log("Normal conversation end");
        setMessages(currentMessages => [...currentMessages, 'Conversation ended']);
      }
    },
    onMessage: (message) => {
      console.log("Received message:", message);
      if (message && typeof message === 'object') {
        // Handle different message types
        if ('message' in message && typeof message.message === 'string') {
          setMessages(currentMessages => [...currentMessages, `Assistant: ${message.message}`]);
        } else if ('text' in message && typeof message.text === 'string') {
          setMessages(currentMessages => [...currentMessages, `Assistant: ${message.text}`]);
        } else {
          // Fallback for other message types
          setMessages(currentMessages => [...currentMessages, `Assistant: ${String(message)}`]);
        }
      }
      
      // Keep the conversation active - don't automatically end it
      console.log("Message received, conversation remains active");
    },
    onError: (error: string | Error) => {
      const errorMsg = typeof error === "string" ? error : (error?.message || 'Unknown error');
      setErrorMessage(`ElevenLabs error: ${errorMsg}`);
      console.error("ElevenLabs error:", error);
      
      // Reset listening state on error
      setIsListening(false);
      stopListeningAnimation();
      
      // Use fallback mode on error
      useFallbackVoiceAssistant();
    },
  });
  
  const {status, isSpeaking} = conversation;
  
  // Animation for the mic button
  const scaleAnimation = useSharedValue(1);
  const pulseAnimation = useSharedValue(1);
  const rotateAnimation = useSharedValue(0);
  
  // Setup navigator mocks and initial setup
  useEffect(() => {
    console.log('Component mounting - setting up navigator...');
    
    // Setup navigator mocks
    try {
      setupNavigatorMocks();
      setIsNavigatorSetup(true);
      console.log('Navigator setup completed');
    } catch (error) {
      console.error('Error setting up navigator:', error);
      setErrorMessage('Failed to setup browser compatibility layer');
    }
    
    // Initial animations
    rotateAnimation.value = withSequence(
      withTiming(-5, { duration: 200 }),
      withTiming(5, { duration: 400 }),
      withTiming(0, { duration: 200 })
    );
    
    // Initial subtle pulse
    pulseAnimation.value = withDelay(
      1000,
      withRepeat(
        withSequence(
          withTiming(1.05, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) })
        ),
        -1, // Infinite repeat
        true // Reverse
      )
    );
    
    // Check for microphone permission on component mount
    checkMicrophonePermission();
    
    // Set initial messages
    setMessages([
      "Hello! I'm your voice assistant.",
      "Tap the mic button to start a conversation.",
      "I'll stay connected until you tap the button again to end the conversation.",
      Platform.OS === 'web' 
        ? "Web version - allow microphone access when prompted."
        : "Note: Full voice features require a development build, not Expo Go."
    ]);
  }, []);

  // Separate useEffect for conversation status monitoring
  useEffect(() => {
    try {
      console.log('Conversation status changed:', status);
      console.log('Is speaking:', isSpeaking);
      
      // Handle disconnections more gracefully
      if (status === 'disconnecting') {
        console.log('Conversation is disconnecting - this might be due to an error or timeout');
        // Don't add a message here, as this might be normal conversation flow
      } else if (status === 'disconnected' && isListening) {
        console.log('Conversation disconnected while listening - this might be unexpected');
        
        // Check if this was an unexpected disconnection (not user-initiated)
        // If the WebSocket closed with an error code, treat it as an error
        setTimeout(() => {
          if (isListening) {
            console.log('Disconnection appears to be unexpected - resetting state');
            setIsListening(false);
            stopListeningAnimation();
            
            setMessages(currentMessages => [
              ...currentMessages, 
              "Connection lost unexpectedly. Please try again or use simplified mode."
            ]);
          }
        }, 1000); // Give it a moment to see if reconnection happens
      }
    } catch (error) {
      console.error('Error in conversation status effect:', error);
    }
  }, [status, isSpeaking]);



  const checkMicrophonePermission = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      setHasPermission(status === 'granted');
      
      if (status !== 'granted') {
        setMessages(currentMessages => [
          ...currentMessages, 
          "I need microphone permission to work properly. Please grant permission in your device settings."
        ]);
      }
    } catch (error) {
      console.error('Error checking microphone permission:', error);
      setHasPermission(false);
    }
  };
  
  const startListeningAnimation = () => {
    pulseAnimation.value = withRepeat(
      withSequence(
        withTiming(1.2, { duration: 500, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) })
      ),
      -1, // Infinite repeat
      true // Reverse
    );
  };
  
  const stopListeningAnimation = () => {
    pulseAnimation.value = withTiming(1, { duration: 300 });
  };
  
  const handlePress = async () => {
    scaleAnimation.value = withSequence(
      withTiming(0.85, { duration: 100 }),
      withTiming(1, { duration: 100 })
    );
    
    // Check permission before proceeding
    if (hasPermission === null) {
      // Permission not determined yet, request it
      const { status } = await Audio.requestPermissionsAsync();
      setHasPermission(status === 'granted');
      
      if (status !== 'granted') {
        Alert.alert(
          'Permission Required',
          'This app needs access to your microphone to enable voice assistant functionality.',
          [
            { 
              text: 'Cancel', 
              style: 'cancel' 
            },
            { 
              text: 'Settings', 
              onPress: () => {
                // On iOS we can link to settings, on Android it's more complex
                if (Platform.OS === 'ios') {
                  Linking.openURL('app-settings:');
                } else {
                  Linking.openSettings();
                }
              }
            }
          ]
        );
        return;
      }
    } else if (hasPermission === false) {
      // Permission was denied previously
      Alert.alert(
        'Permission Denied',
        'Microphone permission is required for the voice assistant to work. Please enable it in your device settings.',
        [
          { 
            text: 'Cancel', 
            style: 'cancel' 
          },
          { 
            text: 'Settings', 
            onPress: () => {
              if (Platform.OS === 'ios') {
                Linking.openURL('app-settings:');
              } else {
                Linking.openSettings();
              }
            }
          }
        ]
      );
      return;
    }
    
    // Toggle listening state
    const newListeningState = !isListening;
    setIsListening(newListeningState);
    
    if (newListeningState) {
      // Starting to listen
      console.log('Starting conversation');
      startListeningAnimation();
      
      // First start the conversation, then update UI based on result
      await handleStartConversation();
    } else {
      // Stopping listening and ending conversation
      console.log('Stopping conversation and ending session');
      stopListeningAnimation();
      
      // Add a message to show we're ending the conversation
      setMessages(currentMessages => [...currentMessages, "Ending conversation..."]);
      
      // Properly end the conversation with ElevenLabs
      if (status === 'connected' || status === 'connecting') {
        await handleEndConversation();
      } else {
        console.log('No active conversation to end');
      }
    }
  };
  
  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { scale: scaleAnimation.value },
        { rotate: `${rotateAnimation.value}deg` }
      ],
    };
  });
  
  const pulseStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { scale: pulseAnimation.value },
      ],
      opacity: 0.7,
    };
  });

  const handleStartConversation = async () => {
    try {
      // Check microphone availability first
      const micAvailable = await checkWebRTCAvailability();
      if (!micAvailable) {
        throw new Error("Microphone access is required for voice conversations");
      }
      
      // Define your agent ID directly or use a constants file
      // TODO: Replace with your working agent ID from ElevenLabs dashboard
      const ELEVENLABS_AGENT_ID = "agent_01jz5bkwcpf01rtev087sv328v";
      
      console.log('Starting ElevenLabs session with agent ID:', ELEVENLABS_AGENT_ID);
      
      // Add a message to show we're trying to connect
      setMessages(currentMessages => [...currentMessages, 'Connecting to voice assistant...']);
      
      // On web, we might need to handle browser permissions differently
      if (Platform.OS === 'web') {
        console.log('Running on web platform - using browser APIs');
        
        // Add a timeout to detect if the connection is taking too long
        const connectionTimeout = setTimeout(() => {
          console.warn('Connection attempt is taking too long, might be a network issue');
          setMessages(currentMessages => [...currentMessages, 'Connection is taking longer than expected...']);
        }, 5000);
        
        // Clean up the timeout when component unmounts or when we get a response
        setTimeout(() => clearTimeout(connectionTimeout), 10000);
      }
      
      try {
        const conversationId = await conversation.startSession({
          agentId: ELEVENLABS_AGENT_ID,
        });
        console.log('Conversation started with ID:', conversationId);
        
        // Update messages with the conversation started message
        setMessages(currentMessages => [...currentMessages, 'Voice conversation started. Speak freely - I\'ll stay connected until you tap the button again.']);
        
        // Show any errors in the UI
        setErrorMessage(null);
      } catch (elevenLabsError) {
        // Log the full error object to understand its structure
        console.error('ElevenLabs error:', elevenLabsError);
        console.error('Error type:', typeof elevenLabsError);
        console.error('Error toString:', String(elevenLabsError));
        
        try {
          console.error('Error JSON:', JSON.stringify(elevenLabsError));
        } catch (e) {
          console.error('Error is not JSON serializable');
        }
        
        // Try to provide more helpful error messages
        let errorMsg: string = "Failed to connect to ElevenLabs";

        // Safely extract error message
        if (elevenLabsError) {
          if (elevenLabsError instanceof Error) {
            errorMsg = elevenLabsError.message || errorMsg;
          } else if (typeof elevenLabsError === 'string') {
            errorMsg = elevenLabsError;
          } else if (typeof elevenLabsError === 'object' && elevenLabsError !== null) {
            errorMsg = (elevenLabsError as any).message || (elevenLabsError as any).error || errorMsg;
          }
        }

        // Only do string operations if errorMsg is really a string and not empty
        if (typeof errorMsg === 'string' && errorMsg) {
          try {
            if (errorMsg.includes('getUserMedia') || errorMsg.includes('mediaDevices')) {
              errorMsg = "Microphone access issue. This might be a limitation when running in Expo Go.";
            }
          } catch (includesError) {
            console.error('Error processing error message:', includesError);
            errorMsg = "Connection error occurred";
          }
        }

        
        setErrorMessage(`ElevenLabs error: ${errorMsg}`);
        setMessages(currentMessages => [...currentMessages, `Error connecting to voice service: ${errorMsg}`]);
        
        // Provide a fallback experience when ElevenLabs fails
        useFallbackVoiceAssistant();
      }
    } catch (error) {
      console.error('Error in handleStartConversation:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`Failed to start conversation: ${errorMsg}`);
      setMessages(currentMessages => [...currentMessages, `Error: ${errorMsg}`]);
      
      // Use fallback when there's a general error
      useFallbackVoiceAssistant();
    }
  };
  
  const handleEndConversation = async () => {
    try {
      console.log('Manually ending conversation session');
      await conversation.endSession();
      console.log('Conversation ended successfully');
      setMessages(currentMessages => [...currentMessages, 'Voice session ended.']);
    } catch (error) {
      console.error('Error ending conversation:', error);
      setErrorMessage(`Error ending conversation: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  
  // Check if microphone is available
  const checkWebRTCAvailability = async () => {
    try {
      console.log('Checking microphone availability...');
      
      if (Platform.OS === 'web') {
        // On web, check if the browser supports getUserMedia
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          console.error('Browser does not support mediaDevices.getUserMedia');
          setErrorMessage('Your browser does not support microphone access');
          return false;
        }
        
        // Check if we have permission to use the microphone
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          console.log('Browser microphone access granted');
          
          // Stop the tracks to release the microphone
          stream.getTracks().forEach(track => track.stop());
          return true;
        } catch (error) {
          console.error('Browser microphone access denied:', error);
          setErrorMessage('Please allow microphone access in your browser');
          return false;
        }
      } else {
        // On mobile, we use our mocked navigator.mediaDevices
        // Check if we have microphone permission first
        const { status } = await Audio.getPermissionsAsync();
        if (status !== 'granted') {
          console.error('Microphone permission not granted');
          setErrorMessage('Microphone permission not granted');
          return false;
        }
        
        // Check if our mock navigator is available
        if (typeof global !== 'undefined' && global.navigator && global.navigator.mediaDevices) {
          console.log('Microphone access should be available');
          return true;
        } else {
          console.error('MediaDevices API not available');
          setErrorMessage('MediaDevices API not available on this device');
          return false;
        }
      }
    } catch (error) {
      console.error('Microphone access check failed:', error);
      setErrorMessage(`Microphone error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  return (
    <ThemedView style={styles.container}>
      {/* Header */}
      <ThemedView style={styles.header}>
        <ThemedText type="title">Voice Assistant</ThemedText>
        {errorMessage && (
          <ThemedText style={styles.errorText}>{errorMessage}</ThemedText>
        )}
        <ThemedText style={styles.statusText}>
          Status: {status || 'unknown'} {isSpeaking ? '(Speaking)' : ''}
        </ThemedText>

      </ThemedView>
      
      {/* Mic Button */}
      <ThemedView style={styles.micContainer}>
        <Animated.View style={[styles.pulseCircle, pulseStyle]} />
        <Animated.View style={animatedStyle}>
          <TouchableOpacity
            style={[
              styles.micButton,
              { 
                backgroundColor: isListening 
                  ? '#E53935' 
                  : hasPermission === false 
                    ? '#9E9E9E' // Gray when permission denied
                    : Colors[colorScheme].tint 
              }
            ]}
            onPress={handlePress}
            activeOpacity={0.8}
          >
            <IconSymbol 
              name="mic.fill" 
              size={32} 
              color="#FFFFFF"
            />
          </TouchableOpacity>
        </Animated.View>
        {hasPermission === false && (
          <ThemedText style={styles.permissionText}>
            Microphone access needed
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
  micContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 200,
  },
  micButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.3)',
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 4,
      },
      shadowOpacity: 0.3,
      shadowRadius: 4.65,
      elevation: 8,
    }),
  },
  pulseCircle: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(10, 126, 164, 0.2)',
  },
  permissionText: {
    marginTop: 10,
    fontSize: 12,
    color: '#E53935',
  },

  errorText: {
    color: '#E53935',
    marginTop: 5,
    fontSize: 14,
  },
  statusText: {
    fontSize: 12,
    marginTop: 5,
    opacity: 0.7,
  },

}); 