/**
 * 启动画面的收尾（设计规范 §3.4.1）。
 *
 * 画面本身写在 index.html 里（窗口首帧就有），这里负责「描多久」和「什么时候撤」：
 * - 描画时长取上次实测的就绪时间（localStorage），让石框描完的一刻与就绪对齐；
 * - App 在设置、会话与 pi 连接都有结论后调用 `dismissBootSplash()`，
 *   若描画还差一点没画完，等到画完再淡出，避免半截标志被切掉；
 * - 无论如何 8 秒后也会撤，失败信息交给界面本身去说。
 */
const LIMIT_MS = 8000
const KEY = 'yan.boot.ms'
const MIN_MS = 360
const MAX_MS = 1600
/* 就绪比描画早时最多再等这么久，慢机器上不为动画拖延首屏 */
const MAX_WAIT_MS = 500
let done = false
let drawMs = 0

const clamp = (n: number): number => Math.min(MAX_MS, Math.max(MIN_MS, Math.round(n)))

function readLast(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? clamp(n) : 0
  } catch {
    return 0
  }
}

function applyDrawTime(): void {
  const el = document.getElementById('boot')
  const ms = readLast()
  if (!el || !ms) return
  drawMs = ms
  el.style.setProperty('--boot-ms', ms + 'ms')
}

export function dismissBootSplash(): void {
  if (done) return
  done = true
  performance.mark('yan:splash-dismiss')
  const el = document.getElementById('boot')
  if (!el) return
  const ready = performance.now()
  try {
    localStorage.setItem(KEY, String(clamp(ready)))
  } catch { /* 存不了就下次用缺省时长 */ }
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const wait = reduced || !drawMs ? 0 : Math.min(MAX_WAIT_MS, Math.max(0, drawMs - ready))
  const fade = (): void => {
    el.classList.add('out')
    const remove = (): void => el.remove()
    /* 子元素的动画结束事件也会冒泡上来，只认自身的淡出 */
    el.addEventListener('animationend', (e) => { if (e.target === el) remove() })
    /* 动画被禁用或事件没来时兜底移除 */
    window.setTimeout(remove, 400)
  }
  if (wait > 0) window.setTimeout(fade, wait)
  else fade()
}

applyDrawTime()
window.setTimeout(dismissBootSplash, LIMIT_MS)
