import { systemPathFor } from "@mobile/auth/native-intent";

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return systemPathFor(path);
  } catch {
    return path;
  }
}
