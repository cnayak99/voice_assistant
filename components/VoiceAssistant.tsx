import React, { useEffect, useState } from 'react';
import { View, Text, Button, StyleSheet, ScrollView } from 'react-native';
import { AIAssistant } from '../services/AIAssistant';
import { ThemedView } from './ThemedView';
import { ThemedText } from './ThemedText';

const VoiceAssistant = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [conversation, setConversation] = useState<Array<{role: string, text: string}>>([]);
  const [assistant, setAssistant] = useState<AIAssistant | null>(null);

  // Initialize the assistant
  useEffect(() => {
    const aiAssistant = new AIAssistant((text, isFinal) => {
      // Handle transcription updates
      if (!isFinal) {
        setTranscript(text);
      } else {
        setTranscript('');
        setConversation(prev => [...prev, { role: 'user', text }]);
      }
    });
    
    setAssistant(aiAssistant);

    // Clean up on unmount
    return () => {
      aiAssistant.stopTranscription();
    };
  }, []);

  // Monkey patch the AIAssistant to capture responses
  useEffect(() => {
    if (assistant) {
      const originalGenerateAIResponse = assistant.generateAIResponse.bind(assistant);
      
      // @ts-ignore - Accessing private method
      assistant.generateAIResponse = async (transcriptText: string) => {
        await originalGenerateAIResponse(transcriptText);
        
        // Extract the last assistant message from fullTranscript
        // @ts-ignore - Accessing private property
        const fullTranscript = assistant['fullTranscript'];
        if (fullTranscript && fullTranscript.length > 0) {
          const lastMessage = fullTranscript[fullTranscript.length - 1];
          if (lastMessage.role === 'assistant') {
            setConversation(prev => [...prev, { role: 'assistant', text: lastMessage.content }]);
          }
        }
      };
    }
  }, [assistant]);

  const toggleListening = async () => {
    if (!assistant) return;
    
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

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.title}>Voice Assistant</ThemedText>
      
      <ScrollView style={styles.conversationContainer}>
        {conversation.map((message, index) => (
          <View 
            key={index} 
            style={[
              styles.messageContainer, 
              message.role === 'user' ? styles.userMessage : styles.assistantMessage
            ]}
          >
            <ThemedText style={styles.messageText}>{message.text}</ThemedText>
          </View>
        ))}
      </ScrollView>
      
      <View style={styles.transcriptContainer}>
        <ThemedText style={styles.transcriptText}>
          {transcript || (isListening ? 'Listening...' : 'Press Start to begin')}
        </ThemedText>
      </View>
      
      <Button 
        title={isListening ? 'Stop' : 'Start'} 
        onPress={toggleListening} 
        color={isListening ? '#FF6347' : '#4CAF50'}
      />
    </ThemedView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
    textAlign: 'center',
  },
  conversationContainer: {
    flex: 1,
    marginBottom: 16,
  },
  messageContainer: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    maxWidth: '80%',
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#DCF8C6',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#E5E5EA',
  },
  messageText: {
    fontSize: 16,
  },
  transcriptContainer: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    marginBottom: 16,
    minHeight: 60,
  },
  transcriptText: {
    fontSize: 16,
    fontStyle: 'italic',
  },
});

export default VoiceAssistant; 