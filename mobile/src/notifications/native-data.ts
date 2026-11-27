function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extracts notification routing data from both local/Android notifications
 * (`content.data`) and Expo iOS remote APNs pushes (`trigger.payload`).
 */
export function readNativeNotificationData(request: {
  content: { data?: unknown };
  trigger?: unknown;
}): Record<string, unknown> | undefined {
  const contentData = request.content.data;
  const trigger = request.trigger;
  if (trigger && typeof trigger === "object" && "type" in trigger && trigger.type === "push") {
    const rawPayload = "payload" in trigger ? trigger.payload : undefined;
    if (isPlainRecord(rawPayload) && Object.keys(rawPayload).length > 0) {
      if (isPlainRecord(contentData) && Object.keys(contentData).length > 0) {
        return { ...rawPayload, ...contentData };
      }
      return rawPayload;
    }
  }
  return isPlainRecord(contentData) ? contentData : undefined;
}
