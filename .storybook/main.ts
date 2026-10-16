import type { StorybookConfig } from '@storybook/react-vite'

/**
 * WP-03 组件工作台配置（仅开发依赖）。
 *
 * Storybook 与 .storybook/** 只服务本地与 CI 的组件预览，不打进产品包：
 * electron-builder 只收 `out/` 与 `resources/`，`package.json` 里 Storybook 全在 devDependencies。
 *
 * 注意：Storybook 的 Vite builder 只自动读取根目录的 `vite.config.*`；
 * 本项目用 `electron.vite.config.ts`，因此不会被误加载，Electron 插件也不会进 Storybook。
 */
const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true }
}

export default config
