const path = require('path')
const fs = require('fs')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const real = (from) => { try { return [fs.realpathSync(path.resolve(__dirname, from))] } catch { return [] } }

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [
    path.resolve(__dirname, '../src/shared'),
    path.resolve(__dirname, '../src/renderer/src/icons'),
    ...real('node_modules'),
    ...real('../node_modules')
  ]
})
