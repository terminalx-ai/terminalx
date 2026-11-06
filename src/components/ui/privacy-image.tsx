import type { ComponentProps } from "react";
import { useDataPrivacy } from "@/lib/dataPrivacy";

/** Webview images also make requests; keep local attachments and QR codes. */
export function PrivacyImage(props: ComponentProps<"img">) {
  const privacy = useDataPrivacy();
  if (privacy.enabled && (props.srcSet || (props.src && /^(https?:|\/\/)/i.test(props.src.trim())))) return null;
  return <img {...props} />;
}
