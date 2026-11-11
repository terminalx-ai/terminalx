import type { ComponentProps } from "react";
import { useDataPrivacy } from "@/lib/dataPrivacy";

/** Webview images also make requests; keep local attachments and QR codes. */
export function PrivacyImage(props: ComponentProps<"img">) {
  const privacy = useDataPrivacy();
  if (privacy.enabled && (props.srcSet || (props.src && externalImage(props.src)))) return null;
  return <img {...props} />;
}

export function externalImage(src: string): boolean {
  if (!/^(https?:|\/\/)/i.test(src.trim())) return false;
  try {
    const url = new URL(src, "https://webview.invalid");
    // open_media_file serves capability URLs on numeric loopback. Tauri's
    // asset protocol uses asset.localhost on WebViews without custom schemes.
    return !["127.0.0.1", "[::1]", "asset.localhost"].includes(url.hostname);
  } catch {
    return true;
  }
}
