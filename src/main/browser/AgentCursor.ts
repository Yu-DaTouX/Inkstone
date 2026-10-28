import type { CdpChannel } from './CdpChannel'

const CURSOR_SCRIPT = `function(label, point) {
  const key = '__inkstoneAgentCursor'
  let state = globalThis[key]
  if (!label) {
    if (state) { clearTimeout(state.timer); state.host.remove(); delete globalThis[key] }
    return
  }
  if (!state || !state.host.isConnected) {
    const host = document.createElement('div')
    host.setAttribute('data-inkstone-agent-cursor', '')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;background:transparent!important;pointer-events:none!important;z-index:2147483647!important'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = '<style>:host{color-scheme:light dark}.cursor{color-scheme:light dark;position:fixed;left:0;top:0;pointer-events:none;transition:transform 140ms ease-out;color:CanvasText}svg{display:block;width:26px;height:32px;filter:drop-shadow(0 1px 2px CanvasText)}.label{position:absolute;left:26px;top:15px;padding:5px 8px;border:1px solid Highlight;border-radius:6px;background:Canvas;color:CanvasText;font:600 12px/1.4 system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px color-mix(in srgb,CanvasText 20%,transparent)}.pulse{position:absolute;left:-12px;top:-12px;width:26px;height:26px;border:2px solid Highlight;border-radius:50%;animation:pulse 500ms ease-out}@keyframes pulse{from{transform:scale(.3);opacity:1}to{transform:scale(1.8);opacity:0}}@media(prefers-reduced-motion:reduce){.cursor{transition:none}.pulse{animation:none}}</style><div class="cursor"><div class="pulse"></div><svg viewBox="0 0 26 32"><path d="M2 2V24L8 18L13 29L18 26L13 16H24Z" fill="Highlight" stroke="Canvas" stroke-width="2" stroke-linejoin="round"/></svg><span class="label"></span></div>'
    document.documentElement.appendChild(host)
    try { host.setAttribute('popover', 'manual'); host.showPopover() } catch {}
    state = { host, cursor: root.querySelector('.cursor'), text: root.querySelector('.label'), pulse: root.querySelector('.pulse'), x: 24, y: 24 }
    globalThis[key] = state
  }
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    state.x = Math.max(2, Math.min(innerWidth - 28, point.x))
    state.y = Math.max(2, Math.min(innerHeight - 34, point.y))
  }
  state.cursor.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)'
  state.text.textContent = 'Agent · ' + label
  state.text.style.left = state.x > innerWidth - 180 ? 'auto' : '26px'
  state.text.style.right = state.x > innerWidth - 180 ? '8px' : 'auto'
  state.text.style.top = state.y > innerHeight - 55 ? '-32px' : '15px'
  state.pulse.getAnimations().forEach(animation => { animation.cancel(); animation.play() })
  clearTimeout(state.timer)
  state.timer = setTimeout(() => { state.host.remove(); if (globalThis[key] === state) delete globalThis[key] }, 2400)
}`

export class AgentCursor {
  constructor(private readonly cdp: CdpChannel) {}

  async show(label: string, point?: { x: number; y: number }): Promise<void> {
    try {
      const tree = await this.cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
      const frameId = tree?.frameTree?.frame?.id
      if (!frameId) return
      const world = await this.cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: 'inkstone-agent-cursor' })
      await this.cdp.send('Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: `(${CURSOR_SCRIPT})(${JSON.stringify(label)},${JSON.stringify(point ?? null)})`,
        returnByValue: true
      })
    } catch {}
  }

  hide(): Promise<void> { return this.show('') }
}
