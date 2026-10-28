import type { CdpChannel } from './CdpChannel'
import { AgentCursor } from './AgentCursor'
import {
  NotSelectElementError,
  SelectOptionNotFoundError,
  StaleElementError,
  type RegisteredElement
} from './ElementRegistry'
import { centerOf, elementBox } from './geometry'
import { pressKey } from './driver/keyboard'
import { dispatchWheelMotion } from './driver/scroll-motion'

const MOD_CTRL = 2
const MOD_META = 4

export class InvalidKeyError extends Error {
  readonly code = 'INVALID_KEY'

  constructor(detail: string) {
    super(`${detail}。支持 Enter、Tab、Escape、Backspace、方向键、Home/End、PageUp/PageDown、单个字符，以及 Control+A、Shift+Tab 这类组合键（修饰键 Control / Shift / Alt / Meta / ControlOrMeta）。`)
    this.name = 'InvalidKeyError'
  }
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

const PICKER_VALUE_FN = `function (text) {
  const el = this
  const kinds = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']
  if ((el.tagName || '').toLowerCase() !== 'input' || !kinds.includes(String(el.type).toLowerCase())) return { picker: false }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  if (typeof el.focus === 'function') el.focus({ preventScroll: true })
  setter.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { picker: true, type: String(el.type), value: String(el.value) }
}`

const READ_VALUE_FN = `function () {
  if ('value' in this && typeof this.value === 'string') return this.value
  if (this.isContentEditable) return String(this.innerText || '')
  return null
}`

const DOM_CLICK_FN = `function () {
  const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }
  if (typeof this.focus === 'function') this.focus({ preventScroll: true })
  this.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }))
  this.dispatchEvent(new MouseEvent('mousedown', init))
  this.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }))
  this.dispatchEvent(new MouseEvent('mouseup', init))
  this.click()
  return true
}`

const SCROLL_POSITION_EXPR = `(() => { const s = document.scrollingElement || document.documentElement; return { x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.max(0, Math.round(s.scrollHeight - innerHeight)) } })()`

export interface SelectOutcome {
  value: string
  label: string
}

export interface TypeOutcome {
  value: string | null
  picker?: string
}

export interface ScrollPosition {
  x: number
  y: number
  maxY: number
}

export class InputController {
  private readonly cursor: AgentCursor

  constructor(private readonly cdp: CdpChannel) { this.cursor = new AgentCursor(cdp) }

  showActivity(label: string): Promise<void> { return this.cursor.show(label) }
  hideActivity(): Promise<void> { return this.cursor.hide() }

  async select(element: RegisteredElement, wanted: string): Promise<SelectOutcome> {
    type Raw = { ok?: boolean; reason?: string; tag?: string; value?: string; label?: string; options?: string[] }
    await this.pointAt(element, '选择')
    const outcome = await this.callOn<Raw>(element, SELECT_VALUE_FN, [wanted])
    if (!outcome?.ok) {
      if (outcome?.reason === 'not_select') {
        throw new NotSelectElementError(element.ref, String(outcome.tag ?? ''))
      }
      throw new SelectOptionNotFoundError(element.ref, wanted, outcome?.options ?? [])
    }
    return { value: String(outcome.value ?? ''), label: String(outcome.label ?? '') }
  }

  async click(element: RegisteredElement): Promise<void> {
    const point = await this.pointAt(element, '点击')
    if (await this.pageHidden(element.sessionId)) {
      await this.callOn(element, DOM_CLICK_FN)
      return
    }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, element.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, element.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, element.sessionId)
  }

  async type(element: RegisteredElement, text: string): Promise<TypeOutcome> {
    await this.pointAt(element, '填写')
    const picker = await this.callOn<{ picker?: boolean; type?: string; value?: string }>(element, PICKER_VALUE_FN, [text])
    if (picker?.picker) return { value: String(picker.value ?? ''), picker: picker.type }
    try {
      await this.cdp.send('DOM.focus', { backendNodeId: element.backendNodeId }, element.sessionId)
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    }
    const modifiers = process.platform === 'darwin' ? MOD_META : MOD_CTRL
    await this.key('keyDown', 'a', 'KeyA', modifiers, 65, element.sessionId)
    await this.key('keyUp', 'a', 'KeyA', modifiers, 65, element.sessionId)
    if (!text) {
      await this.key('keyDown', 'Backspace', 'Backspace', 0, 8, element.sessionId)
      await this.key('keyUp', 'Backspace', 'Backspace', 0, 8, element.sessionId)
    } else {
      await this.cdp.send('Input.insertText', { text }, element.sessionId)
    }
    const value = await this.callOn<string | null>(element, READ_VALUE_FN).catch(() => null)
    return { value: typeof value === 'string' ? value : null }
  }

  async press(chord: string): Promise<void> {
    const normalized = String(chord || '').trim()
    if (!normalized) throw new InvalidKeyError('缺少按键')
    await this.cursor.show('按键')
    try {
      await pressKey({
        cdp: (method, params, sessionId) => this.cdp.send(method, params, sessionId),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      }, normalized)
    } catch (error) {
      if (error instanceof TypeError) throw new InvalidKeyError(error.message)
      throw error
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<ScrollPosition | null> {
    const dx = Number.isFinite(deltaX) ? deltaX : 0
    const dy = Number.isFinite(deltaY) ? deltaY : 0
    if (await this.pageHidden()) {
      await this.cursor.show('滚动')
      await this.cdp.send('Runtime.evaluate', { expression: `window.scrollBy(${dx}, ${dy})`, returnByValue: true })
    } else {
      const metrics = await this.cdp
        .send<{
          cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
          layoutViewport?: { clientWidth?: number; clientHeight?: number }
        }>('Page.getLayoutMetrics')
        .catch(() => null)
      const viewport = metrics?.cssLayoutViewport ?? metrics?.layoutViewport
      await this.cursor.show('滚动', {
        x: Math.max(1, Math.round((viewport?.clientWidth ?? 800) / 2)),
        y: Math.max(1, Math.round((viewport?.clientHeight ?? 600) / 2))
      })
      await dispatchWheelMotion({
        cdp: (method, params) => this.cdp.send(method, params),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      }, {
        x: Math.max(1, Math.round((viewport?.clientWidth ?? 800) / 2)),
        y: Math.max(1, Math.round((viewport?.clientHeight ?? 600) / 2)),
        deltaX: dx,
        deltaY: dy
      })
    }
    return this.scrollPosition()
  }

  async scrollPosition(): Promise<ScrollPosition | null> {
    const state = await this.cdp
      .send<{ result?: { value?: ScrollPosition } }>('Runtime.evaluate', { expression: SCROLL_POSITION_EXPR, returnByValue: true })
      .catch(() => null)
    return state?.result?.value ?? null
  }

  private async pageHidden(sessionId?: string): Promise<boolean> {
    const state = await this.cdp
      .send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId)
      .catch(() => null)
    return state?.result?.value === 'hidden'
  }

  private async callOn<T>(element: RegisteredElement, functionDeclaration: string, args: unknown[] = []): Promise<T | undefined> {
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
    try {
      const call = await this.cdp.send<{ result?: { value?: T } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true
      }, element.sessionId)
      return call?.result?.value
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId }, element.sessionId).catch(() => undefined)
    }
  }

  private async pointAt(element: RegisteredElement, label: string): Promise<{ x: number; y: number }> {
    const point = await this.bringIntoView(element)
    const [offsetX, offsetY] = element.sessionId ? element.frameOffset ?? [0, 0] : [0, 0]
    await this.cursor.show(label, { x: point.x + offsetX, y: point.y + offsetY })
    return point
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
