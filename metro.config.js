const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

const defaultConfig = getDefaultConfig(__dirname);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    ...defaultConfig.resolver,
    alias: {
      '@': __dirname,
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
