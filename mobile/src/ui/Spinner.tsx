import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import Svg, { Circle as Ring, Path } from "react-native-svg";

let reduceMotion = false;
let initialized = false;
let subscription: { remove(): void } | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

/**
 * Shared module-level subscription for `AccessibilityInfo.isReduceMotionEnabled` (P-86).
 * Prevents every mounted `<Spinner>` from issuing its own native bridge query and listener.
 */
function subscribeReduceMotion(listener: () => void): () => void {
  listeners.add(listener);
  if (!initialized) {
    initialized = true;
    const query = AccessibilityInfo?.isReduceMotionEnabled;
    if (typeof query === "function") {
      void query().then((value) => {
        if (value !== reduceMotion) {
          reduceMotion = value;
          emit();
        }
      }).catch(() => undefined);
    }
  }
  if (!subscription && typeof AccessibilityInfo?.addEventListener === "function") {
    subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      if (value !== reduceMotion) {
        reduceMotion = value;
        emit();
      }
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
      initialized = false;
    }
  };
}

const getReduceMotion = () => reduceMotion;

/** Resets the shared reduce-motion store (for tests). */
export function resetReduceMotionStoreForTests(): void {
  subscription?.remove();
  subscription = null;
  initialized = false;
  reduceMotion = false;
  listeners.clear();
}

/** Whether the person asked the system for less motion; a working mark then holds still. */
function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, getReduceMotion, getReduceMotion);
}

/**
 * A ring with a turning arc: the one spinner the boards draw (22.01, 22.04),
 * for an agent at work and for a connection under way.
 */
export const Spinner = memo(function Spinner({ size, color, testID }: { size: number; color: string; testID?: string }) {
  const reduce = useReduceMotion();
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) { turn.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduce, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const stroke = size >= 18 ? 2.25 : 2;
  const radius = (size - stroke) / 2;
  const centre = size / 2;
  return <Animated.View testID={testID} style={{ width: size, height: size, transform: [{ rotate }] }}>
    <Svg width={size} height={size}>
      <Ring cx={centre} cy={centre} r={radius} stroke={color} strokeOpacity={0.25} strokeWidth={stroke} fill="none" />
      <Path d={`M ${centre} ${centre - radius} A ${radius} ${radius} 0 0 1 ${centre + radius} ${centre}`} stroke={color} strokeWidth={stroke} strokeLinecap="round" fill="none" />
    </Svg>
  </Animated.View>;
});
