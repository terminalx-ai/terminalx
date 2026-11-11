import { vi } from "vitest";

// Liquid Glass is native-only: tests draw the fallback surface.
vi.mock("expo-glass-effect", () => ({
  GlassView: ({ children }: { children?: unknown }) => children ?? null,
  GlassContainer: ({ children }: { children?: unknown }) => children ?? null,
  isLiquidGlassAvailable: () => false,
  isGlassEffectAPIAvailable: () => false,
}));

// Drawings are native views: tests draw nothing for them.
vi.mock("react-native-svg", () => {
  const Nothing = () => null;
  return { default: Nothing, Svg: Nothing, Defs: Nothing, Path: Nothing, RadialGradient: Nothing, Rect: Nothing, Stop: Nothing, Circle: Nothing, G: Nothing, Line: Nothing };
});

// Icons draw nothing in tests; any icon the app names exists.
vi.mock("lucide-react-native", () => new Proxy({}, {
  get: (_target, name) => (name === "then" || typeof name === "symbol" ? undefined : name === "__esModule" ? true : () => null),
  has: (_target, name) => name !== "then",
}));

// Image paste is a native module: nothing is pasted unless a test says so.
vi.mock("./modules/paste-image", () => ({ addPasteImageListener: () => () => undefined }));

// Blurs, gradients and masks are native drawing: nothing in tests.
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
vi.mock("@react-native-masked-view/masked-view", () => ({ default: () => null }));
// Dictation is native: tests never hear anything.
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: { start: () => undefined, stop: () => undefined, abort: () => undefined, requestPermissionsAsync: async () => ({ granted: false }) },
  useSpeechRecognitionEvent: () => undefined,
}));

// The device's safe area is native: no notch, no home indicator in tests, unless a test says otherwise.
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: unknown }) => children ?? null,
}));
