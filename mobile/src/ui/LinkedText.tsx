import { Children, isValidElement, memo, useMemo, type ReactNode } from "react";
import { ActionSheetIOS, Alert, Linking, Platform, Text, type StyleProp, type TextProps, type TextStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { isExternalChatUrl, textLinks } from "@terminalx/portable/textLinks";
import { useTheme } from "./theme";

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return Children.toArray(node).map(extractText).join("");
}

/**
 * Whether opening `href` on tap requires an explicit destination confirmation prompt (S-60).
 * Always confirms `tel:` and `mailto:` links, and any `http:`/`https:` link whose displayed
 * label differs from the actual destination URL (masked Markdown links).
 */
export function needsLinkConfirmation(href: string, labelText: string): boolean {
  if (/^(tel|mailto):/i.test(href)) return true;
  const label = labelText.trim();
  if (!label) return true;
  if (label === href) return false;
  // Bare `www.` autolinks expand to `http://www....` via linkify-it without masking the host.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(label) && /^www\./i.test(label) && href.toLowerCase() === `http://${label.toLowerCase()}`) {
    return false;
  }
  return true;
}

/** User-facing title, destination details, and confirm button label for link confirmation (S-60). */
export function linkConfirmationContent(href: string): { title: string; message: string; actionLabel: string } {
  if (/^tel:/i.test(href)) {
    const number = href.slice(4);
    return { title: "Call number?", message: number, actionLabel: "Call" };
  }
  if (/^mailto:/i.test(href)) {
    const address = href.slice(7);
    return { title: "Open email?", message: address, actionLabel: "Open" };
  }
  let host = href;
  try {
    host = new URL(href).host || href;
  } catch {
    host = href;
  }
  return { title: "Open external link?", message: `Destination: ${host}\n\n${href}`, actionLabel: "Open" };
}

export function ChatLink({ href, children, label, style }: { href: string; children: ReactNode; label?: string; style?: StyleProp<TextStyle> }) {
  const { palette } = useTheme();
  const external = isExternalChatUrl(href);
  const labelText = label ?? extractText(children);
  const confirmRequired = external && needsLinkConfirmation(href, labelText);
  const fail = (cause: unknown) => Alert.alert("Could not open link", cause instanceof Error ? cause.message : "Try again.");
  const open = () => { void Linking.openURL(href).catch(fail); };
  const copy = () => { void Clipboard.setStringAsync(href).catch((cause) => Alert.alert("Could not copy link", cause instanceof Error ? cause.message : "Try again.")); };
  const activate = () => {
    if (!external) return actions();
    if (!confirmRequired) return open();
    const { title, message, actionLabel } = linkConfirmationContent(href);
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Copy link", onPress: copy },
      { text: actionLabel, onPress: open },
    ]);
  };
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
  return <Text accessibilityRole="link" accessibilityHint={external ? (confirmRequired ? "Tap to confirm destination before opening. Hold to copy the link." : "Tap to open. Hold to copy the link.") : "Tap to copy this file reference."}
    accessibilityActions={[{ name: "activate", label: external ? "Open link" : "Link actions" }, { name: "copy", label: "Copy link" }]}
    onAccessibilityAction={({ nativeEvent }) => { if (nativeEvent.actionName === "copy") copy(); else if (nativeEvent.actionName === "activate") activate(); }}
    onPress={activate} onLongPress={actions} style={[{ color: palette.accent, textDecorationLine: "underline" }, style]}>{children}</Text>;
}

export function linkedText(text: string): ReactNode[] {
  return textLinks(text).map((part, index) => part.href ? <ChatLink key={index} href={part.href} label={part.text}>{part.text}</ChatLink> : part.text);
}

export const LinkedText = memo(function LinkedText({ children, ...props }: TextProps & { children: string }) {
  const content = useMemo(() => linkedText(children), [children]);
  return <Text {...props} selectable>{content}</Text>;
});
