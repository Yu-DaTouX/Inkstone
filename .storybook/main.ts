import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  core: { disableTelemetry: true },
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true }
}

export default config
