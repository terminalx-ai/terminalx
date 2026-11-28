import { memo, useSyncExternalStore, type ComponentType, type ReactElement, type ReactNode } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import MaskedViewClass from "@react-native-masked-view/masked-view";
import { useTheme } from "./theme";

// The mask's class predates React 19.3's component types; drawn as the component it is.
const MaskedView = MaskedViewClass as unknown as ComponentType<{ style?: StyleProp<ViewStyle>; maskElement: ReactElement; children?: ReactNode }>;

const TO_BOTTOM = { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } } as const;
const TO_TOP = { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } } as const;
const MASK_COLORS = ["transparent", "black", "black"] as const;
const MASK_LOCATIONS = [0, 0.55, 1] as const;
const FADE_LOCATIONS = [0, 0.6, 1] as const;

let reduceTransparency = false;
let transparencyInitialized = false;
let transparencySubscription: { remove(): void } | null = null;
const transparencyListeners = new Set<() => void>();

function emitTransparency() {
  for (const listener of [...transparencyListeners]) listener();
}

function getAccessibilityInfo(): typeof AccessibilityInfo | undefined {
  try {
    return AccessibilityInfo;
  } catch {
    return undefined;
  }
}

function subscribeReduceTransparency(listener: () => void): () => void {
  transparencyListeners.add(listener);
  const info = getAccessibilityInfo();
  if (!transparencyInitialized) {
    transparencyInitialized = true;
    const query = info?.isReduceTransparencyEnabled;
    if (typeof query === "function") {
      void query().then((value) => {
        if (value !== reduceTransparency) {
          reduceTransparency = value;
          emitTransparency();
        }
      }).catch(() => undefined);
    }
  }
  if (!transparencySubscription && typeof info?.addEventListener === "function") {
    transparencySubscription = info.addEventListener("reduceTransparencyChanged", (value) => {
      if (value !== reduceTransparency) {
        reduceTransparency = value;
        emitTransparency();
      }
    });
  }
  return () => {
    transparencyListeners.delete(listener);
    if (transparencyListeners.size === 0) {
      transparencySubscription?.remove();
      transparencySubscription = null;
      transparencyInitialized = false;
    }
  };
}

const getReduceTransparency = () => reduceTransparency;

/** Resets the shared reduce-transparency store (for tests). */
export function resetReduceTransparencyStoreForTests(): void {
  transparencySubscription?.remove();
  transparencySubscription = null;
  transparencyInitialized = false;
  reduceTransparency = false;
  transparencyListeners.clear();
}

function useReduceTransparency(): boolean {
  return useSyncExternalStore(subscribeReduceTransparency, getReduceTransparency, getReduceTransparency);
}

/**
 * Content passing under a bar fades out rather than being cut off: a blur that
 * grows towards the edge, under a fade to the page's colour. On Android and on
 * reduced-transparency devices it falls back to a pure opacity gradient to avoid
 * offscreen GPU Gaussian blur passes every scroll/stream frame (P-85).
 * It takes no touches. `edge` is the side the bar is on.
 */
export const EdgeFade = memo(function EdgeFade({ edge, height, style }: { edge: "top" | "bottom"; height: number; style?: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  const reduced = useReduceTransparency();
  const toEdge = edge === "bottom" ? TO_BOTTOM : TO_TOP;
  const skipBlur = Platform.OS === "android" || reduced;
  return <View pointerEvents="none" style={[styles.fade, edge === "bottom" ? styles.bottom : styles.top, { height }, style]}>
    {skipBlur ? null : <MaskedView style={StyleSheet.absoluteFill} maskElement={<LinearGradient {...toEdge} colors={MASK_COLORS} locations={MASK_LOCATIONS} style={StyleSheet.absoluteFill} />}>
      <BlurView intensity={24} tint="default" style={StyleSheet.absoluteFill} />
    </MaskedView>}
    <LinearGradient {...toEdge} colors={[`${palette.page}00`, `${palette.page}${skipBlur ? "e6" : "cc"}`, palette.page]} locations={FADE_LOCATIONS} style={StyleSheet.absoluteFill} />
  </View>;
});

const styles = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0 },
  bottom: { bottom: 0 },
  top: { top: 0 },
});
