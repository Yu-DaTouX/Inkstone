import type { Decorator, Preview } from '@storybook/react-vite'
import '../src/renderer/src/design/tokens.css'

type ThemeName = 'system' | 'light' | 'dark'
type DensityName = 'compact' | 'standard' | 'comfortable'

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
    a11y: { test: 'todo' }
  }
}

export default preview
