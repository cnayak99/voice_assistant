import React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import VoiceAssistant from './components/VoiceAssistant';
import { useColorScheme } from './hooks/useColorScheme';
import { Colors } from './constants/Colors';

export default function App() {
  const colorScheme = useColorScheme();

  return (
    <SafeAreaView style={[
      styles.container, 
      { backgroundColor: Colors[colorScheme ?? 'light'].background }
    ]}>
      <VoiceAssistant />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
}); 