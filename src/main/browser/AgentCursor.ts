import type { CdpChannel } from './CdpChannel'

const CURSOR_STYLE = [
  ':host{color-scheme:light dark}',
  '.cursor{position:fixed;left:0;top:0;pointer-events:none;opacity:0;transition-property:transform,opacity;transition-duration:0ms,180ms;transition-timing-function:cubic-bezier(.2,.8,.2,1),ease-out;will-change:transform}',
  '.cursor.on{opacity:1}',
  '.arrow{position:absolute;left:-3px;top:-2px;width:22px;height:26px;transform-origin:3px 2px;transition:transform 120ms cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 1px 1px rgba(0,0,0,.28)) drop-shadow(0 3px 6px rgba(0,0,0,.18))}',
  '.arrow svg{display:block;width:100%;height:100%}',
  '.press .arrow{transform:scale(.82)}',
  '.label{position:absolute;left:16px;top:20px;display:flex;align-items:center;gap:6px;max-width:220px;padding:4px 10px 5px;border-radius:4px 12px 12px 12px;background:#2875D2;color:#fff;font:600 12px/16px system-ui,"Segoe UI","Microsoft YaHei UI",sans-serif;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 0 0 1.5px #fff,0 4px 12px rgba(0,0,0,.22);transition:opacity 160ms ease-out}',
  '.label.left{left:auto;right:6px;border-radius:12px 4px 12px 12px}',
  '.label.up{top:-30px;border-radius:12px 12px 12px 4px}',
  '.label.left.up{border-radius:12px 12px 4px 12px}',
  '.busy{display:none;width:6px;height:6px;flex:none;border-radius:50%;background:#fff;animation:breathe 1s ease-in-out infinite}',
  '.idle .busy{display:block}',
  '.text{overflow:hidden;text-overflow:ellipsis}',
  '.ripple{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;background:radial-gradient(circle,rgba(40,117,210,.38) 0,rgba(40,117,210,.18) 45%,rgba(40,117,210,0) 70%);box-shadow:inset 0 0 0 1.5px rgba(40,117,210,.7);opacity:0}',
  '.ripple.go{animation:ripple 560ms cubic-bezier(.2,.8,.2,1)}',
  '@keyframes ripple{from{transform:scale(.2);opacity:1}to{transform:scale(1.6);opacity:0}}',
  '@keyframes breathe{0%,100%{opacity:.35;transform:scale(.75)}50%{opacity:1;transform:scale(1)}}',
  '@media(prefers-reduced-motion:reduce){.cursor,.arrow,.label{transition:none!important}.ripple.go,.busy{animation:none}}'
].join('')

const CURSOR_MARKUP = '<div class="cursor"><div class="ripple"></div><div class="arrow"><svg viewBox="0 0 22 26"><path d="M3.2 2.4c0-.9 1-1.4 1.7-.8l14.2 12.1c.7.6.3 1.8-.7 1.8h-6.1c-.4 0-.8.2-1 .5l-3.9 5.9c-.6.9-1.9.5-2-.6Z" fill="#2875D2" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div><div class="label"><span class="busy"></span><span class="text"></span></div></div>'

const cursorScript = (tap: boolean): string => `function(label, point) {
  const style = ${JSON.stringify(CURSOR_STYLE)}
  const markup = ${JSON.stringify(CURSOR_MARKUP)}
  const tap = ${tap}
  const key = '__inkstoneAgentCursor'
  let state = globalThis[key]
  const finish = (target) => {
    clearTimeout(target.timer)
    clearTimeout(target.pressTimer)
    target.host.remove()
    if (globalThis[key] === target) delete globalThis[key]
  }
  if (!label) {
    if (state) finish(state)
    return
  }
  let fresh = false
  if (!state || !state.host.isConnected) {
    const host = document.createElement('div')
    host.setAttribute('data-inkstone-agent-cursor', '')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;background:transparent!important;pointer-events:none!important;z-index:2147483647!important'
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML = '<style>' + style + '</style>' + markup
    document.documentElement.appendChild(host)
    try { host.setAttribute('popover', 'manual'); host.showPopover() } catch {}
    state = {
      host,
      cursor: root.querySelector('.cursor'),
      label: root.querySelector('.label'),
      text: root.querySelector('.text'),
      ripple: root.querySelector('.ripple'),
      x: 24,
      y: 24
    }
    globalThis[key] = state
    fresh = true
  }
  const moved = !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
  let distance = 0
  if (moved) {
    const x = Math.max(0, Math.min(innerWidth - 1, point.x))
    const y = Math.max(0, Math.min(innerHeight - 1, point.y))
    distance = Math.hypot(x - state.x, y - state.y)
    state.x = x
    state.y = y
  }
  const duration = fresh ? 0 : Math.round(Math.min(420, 160 + distance * 0.35))
  state.cursor.style.transitionDuration = duration + 'ms,180ms'
  state.cursor.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px)'
  state.cursor.classList.toggle('idle', !moved)
  state.text.textContent = label
  state.label.classList.toggle('left', state.x > innerWidth - 200)
  state.label.classList.toggle('up', state.y > innerHeight - 60)
  if (fresh) {
    void state.cursor.offsetWidth
    state.cursor.classList.add('on')
  } else {
    state.cursor.classList.add('on')
  }
  clearTimeout(state.pressTimer)
  state.cursor.classList.remove('press')
  if (moved && tap) {
    const current = state
    current.pressTimer = setTimeout(() => {
      current.cursor.classList.add('press')
      current.ripple.classList.remove('go')
      void current.ripple.offsetWidth
      current.ripple.classList.add('go')
      current.pressTimer = setTimeout(() => current.cursor.classList.remove('press'), 140)
    }, duration)
  }
  clearTimeout(state.timer)
  const current = state
  current.timer = setTimeout(() => {
    current.cursor.classList.remove('on')
    current.timer = setTimeout(() => finish(current), 220)
  }, 2400)
}`

export class AgentCursor {
  constructor(private readonly cdp: CdpChannel) {}

  async show(label: string, point?: { x: number; y: number }, tap = true): Promise<void> {
    try {
      const tree = await this.cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
      const frameId = tree?.frameTree?.frame?.id
      if (!frameId) return
      const world = await this.cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: 'inkstone-agent-cursor' })
      await this.cdp.send('Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: `(${cursorScript(tap)})(${JSON.stringify(label)},${JSON.stringify(point ?? null)})`,
        returnByValue: true
      })
    } catch {}
  }

  hide(): Promise<void> { return this.show('') }
}
