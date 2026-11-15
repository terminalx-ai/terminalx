import Constants from "expo-constants";
import { Platform } from "react-native";

/** "0.1.1 (2)": the version people see in the store, and the build (#987). */
export function appVersion(): string {
  const config = Constants.expoConfig;
  const version = config?.version ?? "unknown";
  const build = Platform.OS === "ios" ? config?.ios?.buildNumber : Platform.OS === "android" && config?.android?.versionCode !== undefined ? String(config.android.versionCode) : undefined;
  return build ? `${version} (${build})` : version;
}
