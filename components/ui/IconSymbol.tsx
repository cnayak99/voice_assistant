import React from 'react';
import { Text, type TextProps, StyleSheet } from 'react-native';
import { useColorScheme } from '../../hooks/useColorScheme';
import { Colors } from '../../constants/Colors';

export interface IconSymbolProps extends TextProps {
  name: string;
  size?: number;
  color?: string;
}

// Simple icon mapping using Unicode symbols
const iconMap: Record<string, string> = {
  microphone: '🎤',
  'microphone-off': '🔇',
  play: '▶️',
  stop: '⏹️',
  pause: '⏸️',
  settings: '⚙️',
  home: '🏠',
  user: '👤',
  check: '✓',
  cross: '✕',
  arrow: '→',
  heart: '♥',
  star: '★',
  menu: '☰',
};

export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  ...rest
}: IconSymbolProps) {
  const colorScheme = useColorScheme();
  const defaultColor = color ?? Colors[colorScheme ?? 'light'].text;
  const symbol = iconMap[name] || name;

  return (
    <Text
      style={[
        styles.icon,
        {
          fontSize: size,
          color: defaultColor,
        },
        style,
      ]}
      {...rest}
    >
      {symbol}
    </Text>
  );
}

const styles = StyleSheet.create({
  icon: {
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
}); 