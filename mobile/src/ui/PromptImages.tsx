import { createContext, useContext, useEffect, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ImageIcon } from "lucide-react-native";
import { useTheme } from "./theme";

type Loaded = { uri: string } | { error: string };
/** Where a conversation's prompt images come from: `scope` names the conversation, `load` asks its Mac for one. */
export interface PromptImageSource { scope: string; load(url: string): Promise<Loaded> }
export const PromptImageContext = createContext<PromptImageSource | null>(null);

// An image is asked for once a conversation, however often its row is drawn; only the latest few are held.
const HELD = 24;
const loaded = new Map<string, Promise<Loaded>>();
const hold = (key: string, pending: Promise<Loaded>) => {
  loaded.delete(key);
  loaded.set(key, pending);
  while (loaded.size > HELD) loaded.delete(loaded.keys().next().value!);
};
const direct = (url: string) => /^(data:|https?:)/.test(url);

/** The images sent with a message, as thumbnails in its bubble; one opens to fill the screen. */
export function PromptImages({ images }: { images: { url: string; name?: string }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const single = images.length === 1;
  return <View style={styles.grid}>
    {images.map((image, index) => <Thumbnail key={`${image.url}:${index}`} image={image} size={single ? 200 : 112} onOpen={setOpen} />)}
    <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
      <Pressable accessibilityLabel="Close image" style={styles.viewer} onPress={() => setOpen(null)}>
        {open ? <Image source={{ uri: open }} resizeMode="contain" style={styles.full} /> : null}
      </Pressable>
    </Modal>
  </View>;
}

function Thumbnail({ image, size, onOpen }: { image: { url: string; name?: string }; size: number; onOpen(uri: string): void }) {
  const { palette } = useTheme();
  const source = useContext(PromptImageContext);
  const [state, setState] = useState<Loaded | null>(() => direct(image.url) ? { uri: image.url } : null);
  useEffect(() => {
    if (direct(image.url) || !source) return;
    let active = true;
    const key = `${source.scope}\n${image.url}`;
    let pending = loaded.get(key);
    // Looked at again, an image is among the latest held.
    if (pending) hold(key, pending);
    if (!pending) {
      pending = source.load(image.url).catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
      hold(key, pending);
      // A refusal is not kept: the next look asks again.
      void pending.then((result) => { if ("error" in result) loaded.delete(key); });
    }
    void pending.then((result) => { if (active) setState(result); });
    return () => { active = false; };
  }, [image.url, source]);
  const name = image.name || "Image";
  if (state && "uri" in state) return <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open ${name}`} onPress={() => onOpen(state.uri)}>
    <Image source={{ uri: state.uri }} accessibilityLabel={name} style={[styles.thumb, { width: size, height: size, backgroundColor: palette.raised }]} />
  </Pressable>;
  // Not loaded yet, or not to be had here: say what it is.
  return <View accessibilityLabel={state && "error" in state ? `${name}: ${state.error}` : name} style={[styles.thumb, styles.placeholder, { width: size, height: size, backgroundColor: palette.raised }]}>
    <ImageIcon size={20} color={palette.faint} />
    <Text numberOfLines={2} style={[styles.name, { color: palette.faint }]}>{state && "error" in state ? state.error : name}</Text>
  </View>;
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  thumb: { borderRadius: 16 },
  placeholder: { alignItems: "center", justifyContent: "center", gap: 6, padding: 10 },
  name: { fontSize: 11, textAlign: "center" },
  viewer: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", justifyContent: "center" },
  full: { width: "100%", height: "85%" },
});
