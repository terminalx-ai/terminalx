// The phone fixture: the real app, its shell and its screens, with only the
// app state replaced by `fixture-app.tsx` and the cloud catalog's provider by
// `fixture-cloud.tsx`. Bundle it with
// EXPO_OVERRIDE_METRO_CONFIG pointing here; see README.md.
/* global __dirname */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const mobile = path.resolve(__dirname, "../..");
const swaps = new Map([
  [path.join(mobile, "src/state/AppProvider.tsx"), path.join(__dirname, "fixture-app.tsx")],
  [path.join(mobile, "src/cloud/CloudProvider.tsx"), path.join(__dirname, "fixture-cloud.tsx")],
]);
const config = getDefaultConfig(mobile);
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = (resolve ?? context.resolveRequest)(context, moduleName, platform);
  const swap = result.type === "sourceFile" ? swaps.get(result.filePath) : undefined;
  return swap ? { type: "sourceFile", filePath: swap } : result;
};
module.exports = config;
