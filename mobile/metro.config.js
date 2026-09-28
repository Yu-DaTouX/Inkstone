/**
 * 协议类型来自桌面仓库的 src/shared/remote-protocol.ts：手机端只做 `import type`，
 * 打包时被 Babel 擦除；把 src/shared 加进 watchFolders，以后若共享运行时常量也能解析。
 */
const path = require('path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [path.resolve(__dirname, '../src/shared'), path.resolve(__dirname, '../src/renderer/src/icons')]
})
