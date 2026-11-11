import { requireOptionalNativeModule } from "expo";

/** An image pasted into a text input, as JPEG. */
export interface PastedImage { data: string; width: number; height: number }

interface PasteImageModule { addListener(event: "onPasteImage", listener: (image: PastedImage) => void): { remove(): void } }
const PasteImage = requireOptionalNativeModule<PasteImageModule>("PasteImage");

/** Calls `listener` with each image pasted into a text input; does nothing where the native module is missing. */
export function addPasteImageListener(listener: (image: PastedImage) => void): () => void {
  const subscription = PasteImage?.addListener("onPasteImage", listener);
  return () => subscription?.remove();
}
