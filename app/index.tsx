import {
    Inter_400Regular,
    Inter_700Bold,
    useFonts,
} from "@expo-google-fonts/inter";
import { StatusBar } from "expo-status-bar";
import { Platform, SafeAreaView, StyleSheet, Text, View } from "react-native";
import ConvAiDOMComponent from "../components/ConvoAi";
import tools from "../utils/tools";
import * as React from "react";

export default function App() {
  const [fontsLoaded] = useFonts({
    "Inter-Regular": Inter_400Regular,
    "Inter-Bold": Inter_700Bold,
  });

  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Voice Assistant</Text>
        
        <View style={styles.buttonContainer}>
          <ConvAiDOMComponent
            dom={{ style: styles.domComponent }}
            platform={Platform.OS}
            get_battery_level={tools.get_battery_level}
            change_brightness={tools.change_brightness}
            flash_screen={tools.flash_screen}
            onMessage={() => {}}
          />
        </View>
        
        <View style={styles.bottomTextContainer}>
          <Text style={styles.bottomText}>Tap to start call</Text>
          <Text style={styles.subText}>Speak naturally - I'm listening</Text>
        </View>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 80,
    paddingBottom: 120,
    paddingHorizontal: 24,
  },
  title: {
    fontFamily: "Inter-Bold",
    fontSize: 32,
    color: "#000",
    textAlign: "center",
  },
  buttonContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  domComponent: {
    width: 120,
    height: 120,
  },
  bottomTextContainer: {
    alignItems: "center",
  },
  bottomText: {
    fontFamily: "Inter-Bold",
    fontSize: 18,
    color: "#000",
    marginBottom: 8,
  },
  subText: {
    fontFamily: "Inter-Regular",
    fontSize: 14,
    color: "#666",
  },
}); 