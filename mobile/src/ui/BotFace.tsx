import { memo, useId } from "react";
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { botColor, faceOf } from "@terminalx/portable/botFace";

/** A chat's bot face, the same one the desktop draws for it: `seed` is the chat's id. */
export const BotFace = memo(function BotFace({ seed, color, size = 36 }: { seed: string; color?: string | null; size?: number }) {
  const face = faceOf(seed);
  const shade = `shade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Defs>
      {/* A little light from the top left, so the blob reads as a body, not a flat shape. */}
      <RadialGradient id={shade} cx="35%" cy="30%" r="80%">
        <Stop offset="0%" stopColor="#fff" stopOpacity={0.22} />
        <Stop offset="100%" stopColor="#000" stopOpacity={0.12} />
      </RadialGradient>
    </Defs>
    <Path d={face.path} fill={color ?? botColor(seed)} />
    <Path d={face.path} fill={`url(#${shade})`} />
    {face.eyes.map((eye, index) => <Rect key={index} x={eye.x - eye.w / 2} y={eye.y - eye.h / 2} width={eye.w} height={eye.h} rx={eye.w / 2} fill="#17171a" fillOpacity={0.85} rotation={eye.tilt} originX={eye.x} originY={eye.y} />)}
  </Svg>;
});
