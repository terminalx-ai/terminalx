import type { ComponentProps } from "react";
import { useDataPrivacy } from "@/lib/dataPrivacy";

/** Webview images also make requests; keep local attachments and QR codes. */
export function PrivacyImage(props: ComponentProps<"img">) {
  const privacy = useDataPrivacy();
  const { srcSet, ...rest } = props;
  if (privacy.enabled && (srcSet || (props.src && externalImage(props.src)))) return null;
  return <img {...rest} srcSet={srcSet} />;
}

export function externalImage(src: string): boolean {
  const trimmed = src.trim();
  if (!/^(https?:|\/\/)/i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed, "https://webview.invalid");
    // open_media_file serves capability URLs on numeric loopback. Tauri's
    // asset protocol uses asset.localhost on WebViews without custom schemes.
    return !["127.0.0.1", "[::1]", "asset.localhost"].includes(url.hostname);
  } catch {
    return true;
  }
}
