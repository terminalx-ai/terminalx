import type { ComponentType, ReactElement, ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import MaskedViewClass from "@react-native-masked-view/masked-view";
import { useTheme } from "./theme";

// The mask's class predates React 19.3's component types; drawn as the component it is.
const MaskedView = MaskedViewClass as unknown as ComponentType<{ style?: StyleProp<ViewStyle>; maskElement: ReactElement; children?: ReactNode }>;

/**
 * Content passing under a bar fades out rather than being cut off: a blur that
 * grows towards the edge, under a fade to the page's colour. It takes no
 * touches. `edge` is the side the bar is on.
 */
export function EdgeFade({ edge, height, style }: { edge: "top" | "bottom"; height: number; style?: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  const toEdge = edge === "bottom" ? { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } } : { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } };
  return <View pointerEvents="none" style={[styles.fade, edge === "bottom" ? styles.bottom : styles.top, { height }, style]}>
    <MaskedView style={StyleSheet.absoluteFill} maskElement={<LinearGradient {...toEdge} colors={["transparent", "black", "black"]} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />}>
      <BlurView intensity={24} tint="default" style={StyleSheet.absoluteFill} />
    </MaskedView>
    <LinearGradient {...toEdge} colors={[`${palette.page}00`, `${palette.page}cc`, palette.page]} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
  </View>;
}

const styles = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0 },
  bottom: { bottom: 0 },
  top: { top: 0 },
});
