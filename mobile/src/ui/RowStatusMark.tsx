import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import Svg, { Circle as Ring, Path } from "react-native-svg";
import { Check, Circle, CircleQuestionMark, ShieldAlert, TriangleAlert } from "lucide-react-native";
import type { RowMark } from "@mobile/data/session-list";
import type { Palette } from "./theme";

/** The colour each mark and its words take (22.04): blue work, amber waits, green done, red failure, grey rest. */
export function markColor(mark: RowMark, palette: Palette): string {
  if (mark === "working") return palette.info;
  if (mark === "answer" || mark === "approval") return palette.warning;
  if (mark === "done") return palette.success;
  if (mark === "failed") return palette.danger;
  return palette.faint;
}

/** Whether the person asked the system for less motion; a working mark then holds still. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (live) setReduce(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => { live = false; subscription.remove(); };
  }, []);
  return reduce;
}

/** A ring with a turning arc, as the design's Working spinner. */
function Spinner({ size, color }: { size: number; color: string }) {
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
  return <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
    <Svg width={size} height={size}>
      <Ring cx={centre} cy={centre} r={radius} stroke={color} strokeOpacity={0.25} strokeWidth={stroke} fill="none" />
      <Path d={`M ${centre} ${centre - radius} A ${radius} ${radius} 0 0 1 ${centre + radius} ${centre}`} stroke={color} strokeWidth={stroke} strokeLinecap="round" fill="none" />
    </Svg>
  </Animated.View>;
}

/** A session's or a tab's status mark. Decorative: the row reads its status in words. */
export function RowStatusMark({ mark, palette, size = 20 }: { mark: RowMark; palette: Palette; size?: number }) {
  const color = markColor(mark, palette);
  if (mark === "working") return <Spinner size={size - 2} color={color} />;
  const Icon = { answer: CircleQuestionMark, approval: ShieldAlert, done: Check, failed: TriangleAlert, idle: Circle }[mark];
  return <Icon size={size} color={color} strokeWidth={2} />;
}
