/**
 * 协议类型来自桌面仓库的 src/shared/remote-protocol.ts：手机端只做 `import type`，
 * 打包时被 Babel 擦除；把 src/shared 加进 watchFolders，以后若共享运行时常量也能解析。
 */
const path = require('path')
const fs = require('fs')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

/**
 * worktree 里的 node_modules 是指向主工作区的 junction：Metro 解析时会展开成真实路径，
 * 必须把真实路径也放进 watchFolders，否则 @babel/runtime 这类依赖会被判成「项目外」。
 * 在主工作区里 realpath 就是自己，这个配置无害。
 */
const real = (from) => { try { return [fs.realpathSync(path.resolve(__dirname, from))] } catch { return [] } }

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [
    path.resolve(__dirname, '../src/shared'),
    path.resolve(__dirname, '../src/renderer/src/icons'),
    ...real('node_modules'),
    ...real('../node_modules')
  ]
})
