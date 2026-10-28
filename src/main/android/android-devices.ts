import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { AndroidControl, AndroidDevice, AndroidFrame } from '../../shared/android-sdk'
import { adbPath, androidAgentEnv, emulatorPath } from './android-paths'

const run = promisify(execFile)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IEND = 0x49454e44
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const RESTART_DELAY_MS = 2000
const KEYCODES: Record<Extract<AndroidControl, { kind: 'key' }>['key'], string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  wake: 'KEYCODE_WAKEUP',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN'
}

export class PngFrameSplitter {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const frames: Buffer[] = []
    for (;;) {
      const start = this.buffer.indexOf(PNG_SIGNATURE)
      if (start < 0) {
        if (this.buffer.length > PNG_SIGNATURE.length) this.buffer = this.buffer.subarray(this.buffer.length - PNG_SIGNATURE.length)
        return frames
      }
      if (start > 0) this.buffer = this.buffer.subarray(start)
      const end = this.frameEnd()
      if (end === 'corrupt') { this.buffer = this.buffer.subarray(1); continue }
      if (end === undefined) return frames
      frames.push(this.buffer.subarray(0, end))
      this.buffer = this.buffer.subarray(end)
    }
  }

  private frameEnd(): number | 'corrupt' | undefined {
    let offset = PNG_SIGNATURE.length
    for (;;) {
      if (offset + 8 > this.buffer.length) return undefined
      const length = this.buffer.readUInt32BE(offset)
      if (length > MAX_FRAME_BYTES) return 'corrupt'
      const next = offset + 12 + length
      if (next > this.buffer.length) return undefined
      if (this.buffer.readUInt32BE(offset + 4) === IEND) return next
      offset = next
    }
  }
}

export function parseAdbDevices(output: string): AndroidDevice[] {
  return output.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/)
    const model = rest.find((part) => part.startsWith('model:'))?.slice(6).replace(/_/g, ' ')
    return { serial, state, ...(model ? { model } : {}), emulator: serial.startsWith('emulator-') }
  })
}

export function inputText(text: string): string {
  return text.replace(/([\\"'`$&|;<>()*?!#~{}[\]])/g, '\\$1').replace(/ /g, '%s')
}

function requireAdb(): string {
  const adb = adbPath()
  if (!adb) throw new Error('没有找到 adb，请先在设置 › 工具 › 安卓开发里安装 Platform-Tools')
  return adb
}

export class AndroidDeviceService {
  private child: ChildProcess | null = null
  private serial: string | null = null
  private latest: { width: number; height: number } | null = null
  private sequence = 0
  private restartTimer: NodeJS.Timeout | null = null

  constructor(private readonly onFrame: (frame: AndroidFrame) => void) {}

  async devices(): Promise<AndroidDevice[]> {
    const { stdout } = await run(requireAdb(), ['devices', '-l'], { windowsHide: true, timeout: 10_000 })
    return parseAdbDevices(stdout)
  }

  async boot(avd: string): Promise<void> {
    const emulator = emulatorPath()
    if (!emulator) throw new Error('没有安装 Android 模拟器')
    const child = spawn(emulator, ['-avd', avd, '-no-boot-anim'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...androidAgentEnv() } })
    child.unref()
  }

  watch(serial: string): void {
    if (this.serial === serial && this.child) return
    this.unwatch()
    this.serial = serial
    this.spawnLoop(serial)
  }

  unwatch(): void {
    this.serial = null
    this.latest = null
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill()
  }

  private spawnLoop(serial: string): void {
    const splitter = new PngFrameSplitter()
    const child = spawn(requireAdb(), ['-s', serial, 'exec-out', 'while :; do screencap -p; done'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const png of splitter.push(chunk)) {
        if (png.length < 24) continue
        const width = png.readUInt32BE(16)
        const height = png.readUInt32BE(20)
        this.latest = { width, height }
        this.onFrame({ serial, png: new Uint8Array(png), width, height, sequence: ++this.sequence })
      }
    })
    child.on('error', () => undefined)
    child.on('exit', () => {
      if (this.child !== child || this.serial !== serial) return
      this.child = null
      this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.serial === serial) this.spawnLoop(serial) }, RESTART_DELAY_MS)
    })
  }

  async control(serial: string, action: AndroidControl): Promise<void> {
    const adb = requireAdb()
    const shell = (args: string[]): Promise<unknown> => run(adb, ['-s', serial, 'shell', ...args], { windowsHide: true, timeout: 15_000 })
    const size = this.serial === serial && this.latest ? this.latest : await this.screenSize(adb, serial)
    const px = (value: number, max: number): string => String(Math.round(Math.max(0, Math.min(1, value)) * (max - 1)))
    if (action.kind === 'tap') await shell(['input', 'tap', px(action.x, size.width), px(action.y, size.height)])
    else if (action.kind === 'swipe') await shell(['input', 'swipe', px(action.x, size.width), px(action.y, size.height), px(action.toX, size.width), px(action.toY, size.height), String(Math.round(action.ms ?? 300))])
    else if (action.kind === 'key') await shell(['input', 'keyevent', KEYCODES[action.key]])
    else {
      if (!/^[\x20-\x7e]*$/.test(action.text)) throw new Error('adb 只能输入英文字符；中文请在手机上用输入法')
      if (action.text) await shell(['input', 'text', inputText(action.text)])
    }
  }

  private async screenSize(adb: string, serial: string): Promise<{ width: number; height: number }> {
    const { stdout } = await run(adb, ['-s', serial, 'shell', 'wm', 'size'], { windowsHide: true, timeout: 10_000 })
    const match = /(?:Override|Physical) size:\s*(\d+)x(\d+)/.exec(stdout.split(/\r?\n/).reverse().join('\n'))
    if (!match) throw new Error('无法读取设备屏幕尺寸')
    return { width: Number(match[1]), height: Number(match[2]) }
  }
}
