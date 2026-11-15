// The Sessions list fixture (#986): the real app, its shell and its screens,
// with only the app state replaced by `fixture-app.tsx`. Bundle it with
// EXPO_OVERRIDE_METRO_CONFIG pointing here; see README.md.
/* global __dirname */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const mobile = path.resolve(__dirname, "../..");
const real = path.join(mobile, "src/state/AppProvider.tsx");
const fixture = path.join(__dirname, "fixture-app.tsx");
const config = getDefaultConfig(mobile);
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = (resolve ?? context.resolveRequest)(context, moduleName, platform);
  return result.type === "sourceFile" && result.filePath === real ? { type: "sourceFile", filePath: fixture } : result;
};
module.exports = config;
