import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/noto-sans-sc/index.css'
import '@fontsource/lxgw-wenkai/index.css'
import '@fontsource/lxgw-wenkai/700.css'
import './fonts.css'

if (typeof document !== 'undefined' && document.fonts) {
  for (const face of ['400 13px "JetBrains Mono NL"', '700 13px "JetBrains Mono NL"']) void document.fonts.load(face, 'W').catch(() => undefined)
}
