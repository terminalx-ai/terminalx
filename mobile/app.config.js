import { withEntitlementsPlist } from "expo/config-plugins";

// Keep static settings in app.json; only development builds carry the D badge.
//
// TERMINALX_PERSONAL_TEAM_BUNDLE_ID: a development build signed with a free
// personal Apple team, which cannot sign push notifications or the shared
// bundle id, goes under this bundle id and without the push entitlement.
// Push notifications do not reach such a build. Unset, nothing changes.
export default ({ config }) => {
  if (process.env.APP_VARIANT !== 'development') return config;
  const development = {
    ...config,
    icon: './assets/icon-dev.png',
    android: {
      ...config.android,
      adaptiveIcon: {
        ...config.android?.adaptiveIcon,
        foregroundImage: './assets/adaptive-icon-dev.png',
      },
    },
  };
  const personal = process.env.TERMINALX_PERSONAL_TEAM_BUNDLE_ID;
  if (!personal) return development;
  return withEntitlementsPlist({ ...development, ios: { ...development.ios, bundleIdentifier: personal } }, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });
};
