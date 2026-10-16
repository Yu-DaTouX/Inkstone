import type { Decorator, Preview } from '@storybook/react-vite'
import '../src/renderer/src/design/tokens.css'

type ThemeName = 'system' | 'light' | 'dark'
type DensityName = 'compact' | 'standard' | 'comfortable'

/**
 * 全局装饰器：把工具栏选中的主题/密度写到 `<html>`，与产品一致。
 *
 * tokens.css 用 `:root[data-theme]` + `color-scheme`，颜色由 `light-dark()` 取值，
 * 阴影由 `[data-theme='dark']` 与 `prefers-color-scheme` 覆盖。
 * `system` 时删除 data-theme，让 `light-dark()` 走系统偏好。
 */
const withThemeAndDensity: Decorator = (Story, context) => {
  const theme = (context.globals.theme ?? 'system') as ThemeName
  const density = (context.globals.density ?? 'standard') as DensityName
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    root.dataset.density = density
    root.style.background = 'var(--bg)'
    root.style.color = 'var(--fg)'
    root.style.fontFamily = 'var(--font-ui)'
    root.style.fontSize = 'var(--t-ui)'
    root.style.lineHeight = 'var(--t-ui-lh)'
  }
  return Story()
}

const preview: Preview = {
  decorators: [withThemeAndDensity],
  globalTypes: {
    theme: {
      description: '主题（data-theme）',
      toolbar: {
        title: '主题',
        icon: 'contrast',
        items: [
          { value: 'system', title: '跟随系统' },
          { value: 'light', title: '浅色' },
          { value: 'dark', title: '深色' }
        ],
        dynamicTitle: true
      }
    },
    density: {
      description: '密度（data-density）',
      toolbar: {
        title: '密度',
        icon: 'ruler',
        items: [
          { value: 'compact', title: '紧凑' },
          { value: 'standard', title: '标准' },
          { value: 'comfortable', title: '宽松' }
        ],
        dynamicTitle: true
      }
    }
  },
  initialGlobals: { theme: 'light', density: 'standard' },
  parameters: {
    layout: 'padded',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    // addon-a11y：默认在面板报告（todo）；接入 CI 时改为 'error' 才算门禁。
    a11y: { test: 'todo' }
  }
}

export default preview
