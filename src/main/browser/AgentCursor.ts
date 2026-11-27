import type { CdpChannel } from './CdpChannel'

export const CURSOR_KINDS = ['click', 'type', 'read', 'scroll', 'open', 'think'] as const
export type CursorKind = (typeof CURSOR_KINDS)[number]

export const CURSOR_STYLE = [
  ':host{color-scheme:light dark}',
  '.cursor{position:fixed;left:0;top:0;pointer-events:none;opacity:0;transition-property:transform,opacity;transition-duration:0ms,180ms;transition-timing-function:cubic-bezier(.2,.8,.2,1),ease-out;will-change:transform}',
  '.cursor.on{opacity:1}',
  '.arrow{position:absolute;left:-3px;top:-2px;width:22px;height:26px;transform-origin:3px 2px;transition:transform 120ms cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 0 2px rgba(255,255,255,.7)) drop-shadow(0 0 5px rgba(255,255,255,.35)) drop-shadow(0 2px 3px rgba(0,0,0,.3))}',
  '.arrow svg{display:block;width:100%;height:100%}',
  '.press .arrow{transform:translate(1px,1px) scale(.8)}',
  '.badge{position:absolute;left:14px;top:18px;display:none;align-items:center;justify-content:center;width:30px;height:24px}',
  '.badge.left{left:auto;right:4px}',
  '.badge.up{top:-28px}',
  '.k-type .badge,.k-read .badge,.k-scroll .badge,.k-open .badge,.k-think .badge{display:flex}',
  '.ic{display:none;flex:none;filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 2px rgba(255,255,255,.9)) drop-shadow(0 1px 2px rgba(0,0,0,.25))}',
  '.k-type .kb,.k-read .eye,.k-scroll .wheel,.k-open .spin,.k-think .dots{display:block}',
  '.k-think .dots{display:flex}',
  '.kb{width:28px;height:18px;overflow:visible}',
  '.kb .b{fill:none;stroke:#111;stroke-width:1.3}',
  '.kb .k{fill:#111;opacity:.45;animation:key 700ms ease-in-out infinite}',
  '.eye{width:28px;height:17px;overflow:visible;transform-origin:50% 50%;animation:blink 2.6s ease-in-out infinite}',
  '.eye .o{fill:none;stroke:#111;stroke-width:1.4;stroke-linejoin:round}',
  '.eye .p{fill:#111;animation:look 2s ease-in-out infinite}',
  '.wheel{width:15px;height:22px;overflow:visible}',
  '.wheel path{fill:none;stroke:#111;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;opacity:.45;animation:sweep 900ms ease-in-out infinite}',
  '.wheel path+path{animation-delay:.25s}',
  '.spin{width:21px;height:21px;animation:spin 800ms linear infinite}',
  '.spin circle{fill:none;stroke:#111;stroke-width:2;stroke-linecap:round;stroke-dasharray:18 40}',
  '.dots{align-items:center;gap:4px;height:14px}',
  '.dots i{width:7px;height:7px;border-radius:50%;background:#111;animation:think 1.2s ease-in-out infinite}',
  '.dots i:nth-child(2){animation-delay:.15s}',
  '.dots i:nth-child(3){animation-delay:.3s}',
  '.ripple{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;background:radial-gradient(circle,rgba(40,117,210,.38) 0,rgba(40,117,210,.18) 45%,rgba(40,117,210,0) 70%);box-shadow:inset 0 0 0 1.5px rgba(40,117,210,.7);opacity:0}',
  '.ripple::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 1.5px rgba(40,117,210,.5);opacity:0}',
  '.ripple.go{animation:ripple 560ms cubic-bezier(.2,.8,.2,1)}',
  '.ripple.go::after{animation:ripple 560ms 140ms cubic-bezier(.2,.8,.2,1) backwards}',
  '@keyframes ripple{from{transform:scale(.2);opacity:1}to{transform:scale(1.6);opacity:0}}',
  '@keyframes key{0%,100%{opacity:.45;transform:translateY(0)}18%{opacity:1;transform:translateY(1.2px)}45%{opacity:.5;transform:translateY(0)}}',
  '@keyframes blink{0%,86%,100%{transform:scaleY(1)}92%{transform:scaleY(.12)}}',
  '@keyframes look{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}',
  '@keyframes sweep{0%,100%{opacity:.45;transform:translateY(-1px)}50%{opacity:1;transform:translateY(1.5px)}}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '@keyframes think{0%,60%,100%{opacity:.45;transform:translateY(0) scale(.8)}30%{opacity:1;transform:translateY(-3px) scale(1)}}',
  '@media(prefers-reduced-motion:reduce){.cursor,.arrow{transition:none!important}.ripple.go,.ripple.go::after,.kb .k,.eye,.eye .p,.wheel path,.spin,.dots i{animation:none}.kb .k,.wheel path{opacity:1}}'
].join('')

export const CURSOR_MARKUP = '<div class="cursor"><div class="ripple"></div><div class="arrow"><svg viewBox="0 0 22 26"><path d="M3.2 2.4c0-.9 1-1.4 1.7-.8l14.2 12.1c.7.6.3 1.8-.7 1.8h-6.1c-.4 0-.8.2-1 .5l-3.9 5.9c-.6.9-1.9.5-2-.6Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div><div class="badge"><svg class="ic kb" viewBox="0 0 20 13"><rect class="b" x=".65" y=".65" width="18.7" height="11.7" rx="2.4"/><rect class="k" x="3.3" y="2.6" width="2.2" height="2" rx=".5" style="animation-delay:0s"/><rect class="k" x="6.1" y="2.6" width="2.2" height="2" rx=".5" style="animation-delay:0.35s"/><rect class="k" x="8.9" y="2.6" width="2.2" height="2" rx=".5" style="animation-delay:0.14s"/><rect class="k" x="11.7" y="2.6" width="2.2" height="2" rx=".5" style="animation-delay:0.49s"/><rect class="k" x="14.5" y="2.6" width="2.2" height="2" rx=".5" style="animation-delay:0.21s"/><rect class="k" x="4.7" y="5.4" width="2.2" height="2" rx=".5" style="animation-delay:0.56s"/><rect class="k" x="7.5" y="5.4" width="2.2" height="2" rx=".5" style="animation-delay:0.07s"/><rect class="k" x="10.3" y="5.4" width="2.2" height="2" rx=".5" style="animation-delay:0.42s"/><rect class="k" x="13.1" y="5.4" width="2.2" height="2" rx=".5" style="animation-delay:0.28s"/><rect class="k" x="5.5" y="8.4" width="9" height="1.8" rx=".5" style="animation-delay:.63s"/></svg><svg class="ic eye" viewBox="0 0 22 13"><path class="o" d="M1.2 6.5C3.8 2.4 7 1 11 1s7.2 1.4 9.8 5.5C18.2 10.6 15 12 11 12S3.8 10.6 1.2 6.5Z"/><circle class="p" cx="11" cy="6.5" r="2.9"/></svg><svg class="ic wheel" viewBox="0 0 12 18"><path d="M2 4.5 6 8.5 10 4.5"/><path d="M2 9.5 6 13.5 10 9.5"/></svg><svg class="ic spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg><span class="ic dots"><i></i><i></i><i></i></span></div></div>'

const cursorScript = (tap: boolean): string => `function(kind, point) {
  const style = ${JSON.stringify(CURSOR_STYLE)}
  const markup = ${JSON.stringify(CURSOR_MARKUP)}
  const tap = ${tap}
  const kinds = ${JSON.stringify(CURSOR_KINDS)}
  const key = '__inkstoneAgentCursor'
  let state = globalThis[key]
  const finish = (target) => {
    clearTimeout(target.timer)
    clearTimeout(target.pressTimer)
    target.host.remove()
    if (globalThis[key] === target) delete globalThis[key]
  }
  if (!kind) {
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
      badge: root.querySelector('.badge'),
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
  for (const name of kinds) state.cursor.classList.toggle('k-' + name, name === kind)
  state.badge.classList.toggle('left', state.x > innerWidth - 80)
  state.badge.classList.toggle('up', state.y > innerHeight - 60)
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

  async show(kind: CursorKind | '', point?: { x: number; y: number }): Promise<void> {
    try {
      const tree = await this.cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
      const frameId = tree?.frameTree?.frame?.id
      if (!frameId) return
      const world = await this.cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: 'inkstone-agent-cursor' })
      await this.cdp.send('Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: `(${cursorScript(kind === 'click')})(${JSON.stringify(kind)},${JSON.stringify(point ?? null)})`,
        returnByValue: true
      })
    } catch {}
  }

  hide(): Promise<void> { return this.show('') }
}
