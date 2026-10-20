import { installFocusModality } from '../src/lib/focusModality'

const THEME_KEY = 'yan.theme'

function applyTheme(): void {
  try {
    const theme = localStorage.getItem(THEME_KEY)
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
  } catch {
  }
}

applyTheme()
installFocusModality()
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === THEME_KEY) applyTheme()
})
