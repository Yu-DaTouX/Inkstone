/**
 * 声音提示（对齐 opencode 的 attention / sounds）。
 *
 * 为什么用 Web Audio **合成**而不是打包 mp3：
 *   · 不引入二进制资源，也不怕打包后路径变化导致静默失败；
 *   · 音量/音色/时长都在代码里，能做得短促、不吵，且可随主题微调；
 *   · 想换音色只改下面的 RECIPES，不需要重新找音频文件。
 *
 * 三类事件与 opencode 的 done / question / error 对齐（见 shared/ipc.ts）。
 */
import type { SoundEvent } from '../../../shared/ipc'

/** 单个音符：频率、相对起点（秒）、时长（秒）、波形、相对增益 */
interface Note {
  f: number
  t: number
  d: number
  type?: OscillatorType
  g?: number
}

/**
 * 每种事件一小段「动机」。
 *
 * 设计原则：两三个音就够 —— 提示音的作用是「不用看屏幕也知道发生了哪类事」，
 * 长了会烦、会盖住语音/会议。done 上扬收尾，question 悬停（等回答），
 * error 下沉。
 */
const RECIPES: Record<SoundEvent, Note[]> = {
  // 完成：E5 → A5，干净的上扬两音
  done: [
    { f: 659.25, t: 0, d: 0.16 },
    { f: 880.0, t: 0.1, d: 0.3, g: 0.9 }
  ],
  /*
   * 提问：D6 → A5 → F#5，**三音下行**。
   *
   * 为什么要跟完成区分开（用户反馈「太像了」）：原来两音都是上行、
   * 音程也接近，听着就是一个东西。现在完成 = 两音上扬，
   * 提问 = 三音下行（更高、更亮、音数也不同），一耳朵能分出来。
   */
  question: [
    { f: 1174.66, t: 0, d: 0.1, type: 'triangle', g: 0.85 },
    { f: 880.0, t: 0.095, d: 0.1, type: 'triangle', g: 0.85 },
    { f: 739.99, t: 0.19, d: 0.34, type: 'triangle', g: 0.95 }
  ],
  // 出错：A4 → F4，三角波，音色偏暗但不刺耳
  error: [
    { f: 440.0, t: 0, d: 0.18, type: 'triangle' },
    { f: 349.23, t: 0.13, d: 0.34, type: 'triangle', g: 0.85 }
  ]
}

/** 同一事件的最小间隔（毫秒）。防「错误风暴」把提示音连成一串噪音 */
const THROTTLE: Record<SoundEvent, number> = {
  done: 250,
  question: 400,
  error: 800
}

let ctx: AudioContext | null = null
let installed = false
const lastAt: Partial<Record<SoundEvent, number>> = {}

function audioContext(): AudioContext | null {
  if (ctx) return ctx
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  } catch {
    /* 拿不到就用不了，静默降级 */
    return null
  }
  return ctx
}

/**
 * 一次性安装「首次用户手势解锁」监听。
 *
 * Chromium 的自动播放策略默认要求先有用户手势，否则 AudioContext 一直是
 * suspended，声音出不来。主进程虽然开了 autoplay-policy 开关（见 index.ts），
 * 但那是 Electron 的行为，这里再兜一层 —— 两种环境下都保证第一次点击后能响。
 */
export function installAudioUnlock(): void {
  if (installed) return
  installed = true
  const unlock = (): void => {
    const c = audioContext()
    if (c && c.state === 'suspended') void c.resume()
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, unlock, { capture: true })
  }
}

/**
 * 播放一个提示音。
 *
 * @param event  事件类型
 * @param volume 0~1（调用方已按设置夹过，这里再夹一次防脏值）
 */
export function playSound(event: SoundEvent, volume = 0.4): void {
  const c = audioContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume()

  // 节流：同类事件太密就丢掉，避免连成一串
  const nowMs = Date.now()
  const last = lastAt[event] ?? 0
  if (nowMs - last < THROTTLE[event]) return
  lastAt[event] = nowMs

  const v = Math.min(1, Math.max(0, volume))
  if (v <= 0) return

  const now = c.currentTime
  const master = c.createGain()
  // 0.5 是「一个音」的基准响度，再乘用户音量
  master.gain.value = v * 0.5
  master.connect(c.destination)

  for (const n of RECIPES[event]) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = n.type ?? 'sine'
    osc.frequency.value = n.f

    const start = now + n.t
    const peak = n.g ?? 1
    // 指数包络：快速起音 + 自然衰减，比方波式的硬切好听
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d)

    osc.connect(gain)
    gain.connect(master)
    osc.start(start)
    osc.stop(start + n.d + 0.02)
  }

  // 播完断开，避免 master 一直挂在 destination 上
  const end = now + Math.max(...RECIPES[event].map((n) => n.t + n.d)) + 0.1
  window.setTimeout(() => master.disconnect(), Math.ceil((end - now) * 1000) + 200)
}

/**
 * 试听（设置面板用）。
 *
 * 与 playSound 的区别：**不走节流** —— 用户连点「试听」应该每次都响，
 * 否则会被误判成「坏了」。
 */
export function previewSound(event: SoundEvent, volume = 0.4): void {
  lastAt[event] = 0
  playSound(event, volume)
}
