// Keep static settings in app.json; only development builds carry the D badge.
export default ({ config }) => {
  if (process.env.APP_VARIANT !== 'development') return config;
  return {
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
};
