import React, { useEffect, useState } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  Animated, 
  Dimensions 
} from 'react-native';
import { AIAssistant } from '../services/AIAssistant';

const { width, height } = Dimensions.get('window');

const VoiceAssistant = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [assistant, setAssistant] = useState<AIAssistant | null>(null);
  
  // Animation values
  const [pulseAnimation] = useState(new Animated.Value(1));
  const [rippleAnimation] = useState(new Animated.Value(0));
  const [buttonScale] = useState(new Animated.Value(1));

  // Initialize the assistant
  useEffect(() => {
    const aiAssistant = new AIAssistant((text, isFinal) => {
      if (!isFinal) {
        setTranscript(text);
      } else {
        setTranscript('');
      }
    });
    
    setAssistant(aiAssistant);

    return () => {
      aiAssistant.stopTranscription();
    };
  }, []);

  // Start pulse animation when listening
  useEffect(() => {
    if (isListening) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnimation, {
            toValue: 1.2,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnimation, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      
      const ripple = Animated.loop(
        Animated.timing(rippleAnimation, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        })
      );
      
      pulse.start();
      ripple.start();
      
      return () => {
        pulse.stop();
        ripple.stop();
      };
    } else {
      pulseAnimation.setValue(1);
      rippleAnimation.setValue(0);
    }
  }, [isListening]);

  const toggleListening = async () => {
    if (!assistant) return;
    
    // Button press animation
    Animated.sequence([
      Animated.timing(buttonScale, {
        toValue: 0.9,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(buttonScale, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();
    
    if (isListening) {
      await assistant.stopTranscription();
      setIsListening(false);
      setTranscript('');
    } else {
      const success = await assistant.startTranscription();
      setIsListening(success);
      if (success) {
        setTranscript('Listening...');
      }
    }
  };

  const getStatusText = () => {
    if (transcript && transcript !== 'Listening...') {
      return transcript;
    }
    if (isListening) {
      return 'Listening...';
    }
    return 'Tap to start conversation';
  };

  const getStatusColor = () => {
    if (transcript && transcript !== 'Listening...') {
      return '#4CAF50'; // Green for active speech
    }
    if (isListening) {
      return '#2196F3'; // Blue for listening
    }
    return '#757575'; // Gray for idle
  };

  return (
    <View style={styles.container}>
      {/* Background gradient effect */}
      <View style={[styles.backgroundGradient, { backgroundColor: isListening ? '#E3F2FD' : '#FAFAFA' }]} />
      
      {/* Top status area */}
      <View style={styles.statusContainer}>
        <Text style={styles.appTitle}>Voice Assistant</Text>
        <View style={styles.statusIndicator}>
          <View style={[styles.statusDot, { backgroundColor: isListening ? '#4CAF50' : '#757575' }]} />
          <Text style={[styles.statusText, { color: getStatusColor() }]}>
            {getStatusText()}
          </Text>
        </View>
      </View>

      {/* Central phone button area */}
      <View style={styles.buttonContainer}>
        {/* Ripple effect rings */}
        {isListening && (
          <>
            <Animated.View
              style={[
                styles.rippleRing,
                {
                  transform: [
                    {
                      scale: rippleAnimation.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 2.5],
                      }),
                    },
                  ],
                  opacity: rippleAnimation.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: [0.3, 0.1, 0],
                  }),
                },
              ]}
            />
            <Animated.View
              style={[
                styles.rippleRing,
                {
                  transform: [
                    {
                      scale: rippleAnimation.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 2],
                      }),
                    },
                  ],
                  opacity: rippleAnimation.interpolate({
                    inputRange: [0, 0.7, 1],
                    outputRange: [0.4, 0.2, 0],
                  }),
                },
              ]}
            />
          </>
        )}

        {/* Main circular button */}
        <Animated.View
          style={[
            styles.phoneButton,
            {
              backgroundColor: isListening ? '#FF5252' : '#4CAF50',
              transform: [
                { scale: Animated.multiply(buttonScale, pulseAnimation) },
              ],
            },
          ]}
        >
          <TouchableOpacity
            style={styles.buttonTouchable}
            onPress={toggleListening}
            activeOpacity={0.8}
          >
            <Text style={styles.phoneIcon}>
              {isListening ? '📞' : '📞'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>

      {/* Bottom instruction area */}
      <View style={styles.instructionContainer}>
        <Text style={styles.instructionText}>
          {isListening ? 'Tap to end call' : 'Tap to start call'}
        </Text>
        {isListening && (
          <Text style={styles.subInstructionText}>
            Speak naturally - I'm listening
          </Text>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  backgroundGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.5,
  },
  statusContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 40,
  },
  appTitle: {
    fontSize: 32,
    fontWeight: '300',
    color: '#212121',
    marginBottom: 40,
    letterSpacing: 1,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 12,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '500',
    maxWidth: width - 120,
    textAlign: 'center',
  },
  buttonContainer: {
    flex: 2,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  rippleRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: '#4CAF50',
  },
  phoneButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  buttonTouchable: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 60,
  },
  phoneIcon: {
    fontSize: 40,
    color: '#FFFFFF',
  },
  instructionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingBottom: 60,
  },
  instructionText: {
    fontSize: 18,
    color: '#424242',
    textAlign: 'center',
    fontWeight: '500',
    marginBottom: 8,
  },
  subInstructionText: {
    fontSize: 14,
    color: '#757575',
    textAlign: 'center',
    fontStyle: 'italic',
  },
});

export default VoiceAssistant; 