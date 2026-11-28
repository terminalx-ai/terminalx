import { requireOptionalNativeModule } from "expo";

/** An image pasted into a text input, as JPEG (temp file URI on native, or legacy base64 data). */
export interface PastedImage { uri?: string; data?: string; width: number; height: number }

interface PasteImageModule { addListener(event: "onPasteImage", listener: (image: PastedImage) => void): { remove(): void } }
const PasteImage = requireOptionalNativeModule<PasteImageModule>("PasteImage");

/** Calls `listener` with each image pasted into a text input; does nothing where the native module is missing. */
export function addPasteImageListener(listener: (image: PastedImage) => void): () => void {
  const subscription = PasteImage?.addListener("onPasteImage", listener);
  return () => subscription?.remove();
}
