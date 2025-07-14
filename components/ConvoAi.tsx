"use dom";
import { useConversation } from '@elevenlabs/react';
import { Phone } from "lucide-react-native";
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import tools from "../utils/tools";

// Define Message type locally to avoid import issues
export type Message = {
  source: string;
  message: string;
};

async function requestMicrophonePermission() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (error) {
    console.log(error);
    console.error("Microphone permission denied");
    return false;
  }
}

export default function ConvAiDOMComponent({
  platform,
  get_battery_level,
  change_brightness,
  flash_screen,
  onMessage,
}: {
  dom?: import("expo/dom").DOMProps;
  platform: string;
  get_battery_level: typeof tools.get_battery_level;
  change_brightness: typeof tools.change_brightness;
  flash_screen: typeof tools.flash_screen;
  onMessage: (message: Message) => void;
}) {
  const conversation = useConversation({
    onConnect: () => console.log("Connected"),
    onDisconnect: () => console.log("Disconnected"),
    onMessage: message => {
      onMessage(message);
    },
    onError: error => console.error("Error:", error),
  });
  
  // Animation state
  const [scaleAnim] = useState(new Animated.Value(1));
  const [pulseAnim] = useState(new Animated.Value(1));
  
  const startConversation = useCallback(async () => {
    try {
      // Request microphone permission
      const hasPermission = await requestMicrophonePermission();
      if (!hasPermission) {
        alert("No permission");
        return;
      }
      //   const signedUrl = await getSignedUrl(); TODO
      // Start the conversation with your agent
      console.log("calling startSession");
      await conversation.startSession({
        agentId: "agent_01jz5bkwcpf01rtev087sv328v", // Replace with your agent ID
        dynamicVariables: {
          platform,
        },
        clientTools: {
          logMessage: async ({ message }) => {
            console.log(message);
          },
          get_battery_level,
          change_brightness,
          flash_screen,
        },
      });
    } catch (error) {
      console.error("Failed to start conversation:", error);
    }
  }, [conversation]);

  const stopConversation = useCallback(async () => {
    await conversation.endSession();
  }, [conversation]);

  const getStatusText = () => {
    switch (conversation.status) {
      case "connected":
        return "Listening...";
      case "connecting":
        return "Connecting...";
      default:
        return "Tap to start conversation";
    }
  };

  const isConnected = conversation.status === "connected";

  // Start/stop pulsing animation based on connection status
  useEffect(() => {
    if (isConnected) {
      // Start pulsing animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      // Stop pulsing and reset
      pulseAnim.stopAnimation();
      Animated.timing(pulseAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [isConnected, pulseAnim]);

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.95,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  };

  return (
    <View style={styles.container}>
      <View style={styles.statusContainer}>
        <View style={[styles.statusDot, isConnected && styles.statusDotActive]} />
        <Text style={[styles.statusText, isConnected && styles.statusTextActive]}>
          {getStatusText()}
        </Text>
      </View>
      
      <Animated.View
        style={[
          styles.buttonWrapper,
          {
            transform: [
              { scale: Animated.multiply(scaleAnim, pulseAnim) }
            ],
          },
        ]}
      >
        <Pressable
          style={[
            styles.callButton,
            isConnected && styles.callButtonActive,
          ]}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onPress={
            conversation.status === "disconnected"
              ? startConversation
              : stopConversation
          }
        >
          <Phone
            size={32}
            color="#fff"
            strokeWidth={1.5}
          />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 40,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ccc",
    marginRight: 8,
  },
  statusDotActive: {
    backgroundColor: "#22C55E",
  },
  statusText: {
    fontSize: 16,
    color: "#666",
    fontWeight: "500",
  },
  statusTextActive: {
    color: "#22C55E",
  },
  buttonWrapper: {
    // Wrapper for animation
  },
  callButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#22C55E",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#22C55E",
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  callButtonActive: {
    backgroundColor: "#EF4444",
    shadowColor: "#EF4444",
  },
});