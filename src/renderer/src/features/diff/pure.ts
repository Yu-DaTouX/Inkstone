/**
 * Diff 纯逻辑出口（无 React / 无 DOM / 无 IO）。
 *
 * `scripts/test-v3-diff.mjs` 只编译这一个文件，用 esbuild 打包后在 Node 里
 * 直接跑；React 组件 `DiffView` 不在这里，避免把渲染层带进单测。
 */
export * from './types'
export * from './limits'
export * from './parse'
export * from './align'
export * from './word-diff'
export * from './fold'
