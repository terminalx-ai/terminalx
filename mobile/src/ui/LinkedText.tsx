import { memo, useMemo, type ReactNode } from "react";
import { ActionSheetIOS, Alert, Linking, Platform, Text, type TextProps } from "react-native";
import * as Clipboard from "expo-clipboard";
import { isExternalChatUrl, textLinks } from "@terminalx/portable/textLinks";
import { useTheme } from "./theme";

export function ChatLink({ href, children }: { href: string; children: ReactNode }) {
  const { palette } = useTheme();
  const external = isExternalChatUrl(href);
  const fail = (cause: unknown) => Alert.alert("Could not open link", cause instanceof Error ? cause.message : "Try again.");
  const open = () => { void Linking.openURL(href).catch(fail); };
  const copy = () => { void Clipboard.setStringAsync(href).catch((cause) => Alert.alert("Could not copy link", cause instanceof Error ? cause.message : "Try again.")); };
  const actions = () => {
    if (Platform.OS === "ios") {
      const options = external ? ["Open link", "Copy link", "Cancel"] : ["Copy link", "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1, title: href }, (index) => {
        if (index === options.indexOf("Open link")) open();
        else if (index === options.indexOf("Copy link")) copy();
      });
    } else {
      Alert.alert("Link", href, [...(external ? [{ text: "Open link", onPress: open }] : []), { text: "Copy link", onPress: copy }, { text: "Cancel", style: "cancel" }]);
    }
  };
  // File references belong to the paired host. They still expose their full
  // destination for copying; executable URL schemes never reach Linking.
  return <Text accessibilityRole="link" accessibilityHint={external ? "Tap to open. Hold to copy the link." : "Tap to copy this file reference."}
    accessibilityActions={[{ name: "activate", label: external ? "Open link" : "Link actions" }, { name: "copy", label: "Copy link" }]}
    onAccessibilityAction={({ nativeEvent }) => { if (nativeEvent.actionName === "copy") copy(); else if (nativeEvent.actionName === "activate") { if (external) open(); else actions(); } }}
    onPress={external ? open : actions} onLongPress={actions} style={{ color: palette.accent, textDecorationLine: "underline" }}>{children}</Text>;
}

export function linkedText(text: string): ReactNode[] {
  return textLinks(text).map((part, index) => part.href ? <ChatLink key={index} href={part.href}>{part.text}</ChatLink> : part.text);
}

export const LinkedText = memo(function LinkedText({ children, ...props }: TextProps & { children: string }) {
  const content = useMemo(() => linkedText(children), [children]);
  return <Text {...props} selectable>{content}</Text>;
});
