import type { CdpChannel } from './CdpChannel'
import { StaleElementError, type RegisteredElement } from './ElementRegistry'
import { centerOf, elementBox } from './geometry'

/** CDP `Input.dispatchKeyEvent` 的修饰键位掩码 */
const MOD_CTRL = 2
const MOD_META = 4

/**
 * 命名键 → (key, code, windowsVirtualKeyCode)。
 *
 * 之前只对单字符做 `Key${upper}`，于是空格变成非法的 `Key `、数字变成
 * 非法的 `Key1`。命名键保留常见的那几个即可。
 */
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
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
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
  return { key: raw, code: raw }
}

/** 把「节点已从文档移除」翻译成可重试的 STALE_ELEMENT，而不是一串 CDP 原文 */
function staleFromCdp(error: unknown, ref: string): StaleElementError | null {
  const message = error instanceof Error ? error.message : String(error)
  if (/detached|Could not find node|No node with given id|Cannot find context/i.test(message)) {
    return new StaleElementError(ref)
  }
  return null
}

export class InputController {
  constructor(private readonly cdp: CdpChannel) {}

  async click(element: RegisteredElement): Promise<void> {
    const point = await this.bringIntoView(element)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }

  async type(element: RegisteredElement, text: string): Promise<void> {
    try {
      await this.cdp.send('DOM.focus', { backendNodeId: element.backendNodeId })
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    }
    // 全选后 insertText 才能**替换**原值；macOS 的全选是 Cmd 而不是 Ctrl，
    // 用 Ctrl 在 mac 上只会把光标移到行首，文字被追加而不是覆盖。
    const modifiers = process.platform === 'darwin' ? MOD_META : MOD_CTRL
    await this.key('keyDown', 'a', 'KeyA', modifiers, 65)
    await this.key('keyUp', 'a', 'KeyA', modifiers, 65)
    await this.cdp.send('Input.insertText', { text })
  }

  async press(key: string): Promise<void> {
    const normalized = String(key || '').trim()
    if (!normalized) throw new Error('缺少按键')
    const spec = keySpec(normalized)
    await this.key('keyDown', spec.key, spec.code, 0, spec.keyCode)
    await this.key('keyUp', spec.key, spec.code, 0, spec.keyCode)
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    // 滚轮事件落在光标下方的元素上；固定在 (10,10) 会被左上角的
    // 固定头部/横幅截走。用视口中心，滚到的是页面主体。
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

  /**
   * 先把元素滚进视口，再**重新量**它的位置。
   *
   * 这里的顺序是关键：`browser_observe` 记录的 box 是观察那一刻的视口坐标。
   * 对首屏之外的元素，`scrollIntoViewIfNeeded` 会把页面滚动一段，
   * 再用旧坐标去点，等于点在元素原来的位置（已经在视口外），
   * 结果是「返回成功但什么都没发生」。
   */
  private async bringIntoView(element: RegisteredElement): Promise<{ x: number; y: number }> {
    try {
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId })
    } catch (error) {
      throw staleFromCdp(error, element.ref) ?? error
    }
    const box = await elementBox(this.cdp, element.backendNodeId)
    return centerOf(box ?? element.box)
  }

  private async key(type: 'keyDown' | 'keyUp', key: string, code: string, modifiers: number, keyCode?: number): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    })
  }
}
