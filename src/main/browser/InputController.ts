import type { CdpChannel } from './CdpChannel'
import {
  NotSelectElementError,
  SelectOptionNotFoundError,
  StaleElementError,
  type RegisteredElement
} from './ElementRegistry'
import { centerOf, elementBox } from './geometry'

const MOD_CTRL = 2
const MOD_META = 4

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  '/': { key: '/', code: 'Slash', keyCode: 191 },
  '.': { key: '.', code: 'Period', keyCode: 190 },
  ',': { key: ',', code: 'Comma', keyCode: 188 },
  ';': { key: ';', code: 'Semicolon', keyCode: 186 },
  '-': { key: '-', code: 'Minus', keyCode: 189 },
  '=': { key: '=', code: 'Equal', keyCode: 187 },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219 },
  ']': { key: ']', code: 'BracketRight', keyCode: 221 },
  '\\\\': { key: '\\\\', code: 'Backslash', keyCode: 220 },
  "'": { key: "'", code: 'Quote', keyCode: 222 },
  '`': { key: '`', code: 'Backquote', keyCode: 192 }
}

function keySpec(raw: string): { key: string; code: string; keyCode?: number } {
  const named = NAMED_KEYS[raw.toLowerCase()]
  if (named) return named
  if (raw.length === 1 && /[a-z]/i.test(raw)) {
    return { key: raw, code: `Key${raw.toUpperCase()}`, keyCode: raw.toUpperCase().charCodeAt(0) }
  }
  if (raw.length === 1 && /[0-9]/.test(raw)) {
    return { key: raw, code: `Digit${raw}`, keyCode: raw.charCodeAt(0) }
  }
  throw new Error(`不支持的按键：${raw}`)
}

function staleFromCdp(error: unknown, ref: string): StaleElementError | null {
  const message = error instanceof Error ? error.message : String(error)
  if (/detached|Could not find node|No node with given id|Cannot find context/i.test(message)) {
    return new StaleElementError(ref)
  }
  return null
}

export const SELECT_VALUE_FN = `function (wanted) {
  const el = this
  const tag = (el.tagName || '').toLowerCase()
  if (tag !== 'select') return { ok: false, reason: 'not_select', tag: tag }
  const opts = Array.from(el.options || [])
  const hit =
    opts.find((o) => o.value === wanted) ||
    opts.find((o) => String(o.label || o.text || '').trim() === wanted)
  if (!hit) return { ok: false, reason: 'no_option', options: opts.map((o) => o.value) }
  el.value = hit.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: el.value, label: String(hit.label || hit.text || '').trim() }
}`

export interface SelectOutcome {
  value: string
  label: string
}

export class InputController {
  constructor(private readonly cdp: CdpChannel) {}

  async select(element: RegisteredElement, wanted: string): Promise<SelectOutcome> {
    let objectId: string | undefined
    try {
      const resolved = await this.cdp.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: element.backendNodeId
      }, element.sessionId)
      objectId = resolved?.object?.objectId
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    }
    if (!objectId) throw new StaleElementError(element.ref)

    type Raw = { ok?: boolean; reason?: string; tag?: string; value?: string; label?: string; options?: string[] }
    let outcome: Raw | undefined
    try {
      const call = await this.cdp.send<{ result?: { value?: Raw } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: SELECT_VALUE_FN,
        arguments: [{ value: wanted }],
        returnByValue: true
      }, element.sessionId)
      outcome = call?.result?.value
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId }, element.sessionId).catch(() => undefined)
    }

    if (!outcome?.ok) {
      if (outcome?.reason === 'not_select') {
        throw new NotSelectElementError(element.ref, String(outcome.tag ?? ''))
      }
      throw new SelectOptionNotFoundError(element.ref, wanted, outcome?.options ?? [])
    }
    return { value: String(outcome.value ?? ''), label: String(outcome.label ?? '') }
  }

  async click(element: RegisteredElement): Promise<void> {
    const point = await this.bringIntoView(element)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, element.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, element.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, element.sessionId)
  }

  async type(element: RegisteredElement, text: string): Promise<void> {
    try {
      await this.cdp.send('DOM.focus', { backendNodeId: element.backendNodeId }, element.sessionId)
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    }
    const modifiers = process.platform === 'darwin' ? MOD_META : MOD_CTRL
    await this.key('keyDown', 'a', 'KeyA', modifiers, 65, element.sessionId)
    await this.key('keyUp', 'a', 'KeyA', modifiers, 65, element.sessionId)
    await this.cdp.send('Input.insertText', { text }, element.sessionId)
  }

  async press(key: string): Promise<void> {
    const normalized = String(key || '').trim()
    if (!normalized) throw new Error('缺少按键')
    const spec = keySpec(normalized)
    await this.key('keyDown', spec.key, spec.code, 0, spec.keyCode)
    await this.key('keyUp', spec.key, spec.code, 0, spec.keyCode)
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    const metrics = await this.cdp
      .send<{
        cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
        layoutViewport?: { clientWidth?: number; clientHeight?: number }
      }>('Page.getLayoutMetrics')
      .catch(() => null)
    const viewport = metrics?.cssLayoutViewport ?? metrics?.layoutViewport
    const x = Math.max(1, Math.round((viewport?.clientWidth ?? 800) / 2))
    const y = Math.max(1, Math.round((viewport?.clientHeight ?? 600) / 2))
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: Number.isFinite(deltaX) ? deltaX : 0,
      deltaY: Number.isFinite(deltaY) ? deltaY : 0
    })
  }

  private async bringIntoView(element: RegisteredElement): Promise<{ x: number; y: number }> {
    try {
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId }, element.sessionId)
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    }
    const box = await elementBox(this.cdp, element.backendNodeId, element.sessionId)
    const [offsetX, offsetY] = element.frameOffset ?? [0, 0]
    const fallback = element.sessionId
      ? [element.box[0] - offsetX, element.box[1] - offsetY, element.box[2], element.box[3]] as [number, number, number, number]
      : element.box
    return centerOf(box ?? fallback)
  }

  private async key(type: 'keyDown' | 'keyUp', key: string, code: string, modifiers: number, keyCode?: number, sessionId?: string): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    }, sessionId)
  }
}
