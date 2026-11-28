import fs from "node:fs";
import path from "node:path";
import { withAndroidManifest, withDangerousMod, withInfoPlist } from "expo/config-plugins";

/**
 * Android network security configuration (S-46):
 * Disables global cleartext traffic (`cleartextTrafficPermitted="false"`) and permits
 * cleartext only for local loopback and `.local` mDNS LAN endpoints.
 */
export const LAN_NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="true">local</domain>
  </domain-config>
</network-security-config>
`;

/**
 * Strips `exp+*` development URL schemes from iOS `Info.plist` `CFBundleURLTypes`
 * so production builds never expose the Expo dev-client scheme (`exp+terminalx-mobile`, S-57).
 */
export function stripDevUrlSchemes(infoPlist) {
  const urlTypes = infoPlist?.CFBundleURLTypes;
  if (!Array.isArray(urlTypes)) return infoPlist;
  const filtered = urlTypes
    .map((entry) => {
      if (!entry || !Array.isArray(entry.CFBundleURLSchemes)) return entry;
      const schemes = entry.CFBundleURLSchemes.filter((scheme) => typeof scheme === "string" && !/^exp\+/i.test(scheme));
      return { ...entry, CFBundleURLSchemes: schemes };
    })
    .filter((entry) => !Array.isArray(entry?.CFBundleURLSchemes) || entry.CFBundleURLSchemes.length > 0);
  return { ...infoPlist, CFBundleURLTypes: filtered };
}

/**
 * Applies Android LAN-only `network_security_config.xml` (S-46) and strips dev URL
 * schemes from production iOS `Info.plist` builds (S-57).
 */
export function withSecurityHardening(config, { isDevelopment = false } = {}) {
  let next = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application?.$) {
      application.$["android:usesCleartextTraffic"] = "false";
      application.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    }
    return mod;
  });

  next = withDangerousMod(next, [
    "android",
    async (mod) => {
      const xmlDir = path.join(mod.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "network_security_config.xml"), LAN_NETWORK_SECURITY_CONFIG_XML, "utf8");
      return mod;
    },
  ]);

  if (!isDevelopment) {
    next = withInfoPlist(next, (mod) => {
      mod.modResults = stripDevUrlSchemes(mod.modResults);
      return mod;
    });
  }

  return next;
}
