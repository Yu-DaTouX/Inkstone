import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { AndroidControl, AndroidDevice, AndroidFrame } from '../../shared/android-sdk'
import { adbPath, emulatorEnv, emulatorPath } from './android-paths'

const run = promisify(execFile)
const START_CODE = Buffer.from([0, 0, 0, 1])
const NAL_PREFIX = START_CODE.subarray(1)
const MAX_STREAM_EDGE = 1600
const FLUSH_DELAY_MS = 8
const RESTART_DELAY_MS = 2000
const INPUT_ACK = '__inkstone_input_done__'
const TOUCH_PHASES = new Set(['down', 'move', 'up'])
const KEYCODES: Record<Extract<AndroidControl, { kind: 'key' }>['key'], string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  wake: 'KEYCODE_WAKEUP',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN'
}

export interface H264Packet {
  data: Uint8Array
  key: boolean
  codec: string
}

export class H264Splitter {
  private buffer: Buffer = Buffer.alloc(0)
  private config: Buffer[] = []
  private slices: Buffer[] = []
  private key = false
  private codec = ''

  push(chunk: Buffer): H264Packet[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const packets: H264Packet[] = []
    for (;;) {
      const first = this.buffer.indexOf(NAL_PREFIX)
      if (first < 0) return packets
      const next = this.buffer.indexOf(NAL_PREFIX, first + 3)
      if (next < 0) {
        this.buffer = this.buffer.subarray(first)
        return packets
      }
      this.unit(this.buffer.subarray(first + 3, this.buffer[next - 1] === 0 ? next - 1 : next), packets)
      this.buffer = this.buffer.subarray(next)
    }
  }

  flush(): H264Packet[] {
    const packets: H264Packet[] = []
    if (this.buffer.length > 3 && this.buffer.indexOf(NAL_PREFIX) === 0) {
      this.unit(this.buffer.subarray(3), packets)
      this.buffer = Buffer.alloc(0)
    }
    this.finish(packets)
    return packets
  }

  private unit(nal: Buffer, packets: H264Packet[]): void {
    if (!nal.length) return
    const type = nal[0] & 0x1f
    if (type === 1 || type === 5) {
      if (nal.length > 1 && nal[1] & 0x80) this.finish(packets)
      this.slices.push(nal)
      if (type === 5) this.key = true
      return
    }
    this.finish(packets)
    if (type === 7 && nal.length >= 4) this.codec = `avc1.${nal.subarray(1, 4).toString('hex')}`
    this.config.push(nal)
  }

  private finish(packets: H264Packet[]): void {
    if (!this.slices.length) return
    const parts = [...this.config, ...this.slices].flatMap((nal) => [START_CODE, nal])
    if (this.codec) packets.push({ data: new Uint8Array(Buffer.concat(parts)), key: this.key, codec: this.codec })
    this.config = []
    this.slices = []
    this.key = false
  }
}

export function streamSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_STREAM_EDGE / Math.max(width, height))
  const align = (value: number): number => Math.max(16, Math.round((value * scale) / 16) * 16)
  return { width: align(width), height: align(height) }
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

export class InputShell {
  private child: ChildProcess | null = null
  private queue: { command: string; merge: boolean }[] = []
  private busy = false
  private output = ''

  constructor(private readonly adb: string, readonly serial: string) {}

  send(command: string, merge = false): void {
    const last = this.queue.at(-1)
    if (merge && last?.merge) last.command = command
    else this.queue.push({ command, merge })
    this.pump()
  }

  close(): void {
    this.queue = []
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill()
  }

  private pump(): void {
    if (this.busy) return
    const next = this.queue.shift()
    if (!next) return
    this.busy = true
    this.shell().stdin?.write(`${next.command}; echo ${INPUT_ACK}\n`)
  }

  private shell(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child
    const child = spawn(this.adb, ['-s', this.serial, 'shell'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    this.output = ''
    child.stdin?.on('error', () => undefined)
    child.on('error', () => undefined)
    child.stdout?.on('data', (chunk: Buffer) => {
      this.output += chunk.toString('latin1')
      let at = this.output.indexOf(INPUT_ACK)
      while (at >= 0) {
        this.output = this.output.slice(at + INPUT_ACK.length)
        this.busy = false
        this.pump()
        at = this.output.indexOf(INPUT_ACK)
      }
      if (this.output.length > 4096) this.output = this.output.slice(-INPUT_ACK.length)
    })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.busy = false
      this.pump()
    })
    return child
  }
}

export class AndroidDeviceService {
  private child: ChildProcess | null = null
  private serial: string | null = null
  private latest: { width: number; height: number } | null = null
  private sequence = 0
  private generation = 0
  private restartTimer: NodeJS.Timeout | null = null
  private input: InputShell | null = null

  constructor(private readonly onFrame: (frame: AndroidFrame) => void) {}

  async devices(): Promise<AndroidDevice[]> {
    const { stdout } = await run(requireAdb(), ['devices', '-l'], { windowsHide: true, timeout: 10_000 })
    return parseAdbDevices(stdout)
  }

  async boot(avd: string): Promise<void> {
    const emulator = emulatorPath()
    if (!emulator) throw new Error('没有安装 Android 模拟器')
    const child = spawn(emulator, ['-avd', avd, '-no-boot-anim'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')), ...emulatorEnv() } })
    child.unref()
  }

  watch(serial: string): void {
    this.unwatch()
    this.serial = serial
    void this.spawnLoop(serial)
  }

  unwatch(): void {
    this.serial = null
    this.latest = null
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill()
  }

  private async spawnLoop(serial: string): Promise<void> {
    const adb = requireAdb()
    const generation = ++this.generation
    const size = await this.screenSize(adb, serial).catch(() => null)
    if (this.serial !== serial || this.child || generation !== this.generation) return
    if (size) this.latest = size
    const stream = size ? streamSize(size.width, size.height) : null
    const args = ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--time-limit', '0', '--bit-rate', '8000000', ...(stream ? ['--size', `${stream.width}x${stream.height}`] : []), '-']
    const child = spawn(adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    this.child = child
    const splitter = new H264Splitter()
    let flushTimer: NodeJS.Timeout | null = null
    const emit = (packets: H264Packet[]): void => {
      for (const packet of packets) this.onFrame({ serial, ...packet, sequence: ++this.sequence })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      emit(splitter.push(chunk))
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(() => { flushTimer = null; emit(splitter.flush()) }, FLUSH_DELAY_MS)
    })
    child.on('error', () => undefined)
    child.on('exit', () => {
      if (flushTimer) clearTimeout(flushTimer)
      if (this.child !== child || this.serial !== serial) return
      this.child = null
      this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.serial === serial) void this.spawnLoop(serial) }, RESTART_DELAY_MS)
    })
  }

  async control(serial: string, action: AndroidControl): Promise<void> {
    const adb = requireAdb()
    if (this.input?.serial !== serial) {
      this.input?.close()
      this.input = new InputShell(adb, serial)
    }
    const input = this.input
    if (action.kind === 'key') return input.send(`input keyevent ${KEYCODES[action.key]}`)
    if (action.kind === 'text') {
      if (!/^[\x20-\x7e]*$/.test(action.text)) throw new Error('adb 只能输入英文字符；中文请在手机上用输入法')
      if (action.text) input.send(`input text ${inputText(action.text)}`)
      return
    }
    const size = this.serial === serial && this.latest ? this.latest : await this.screenSize(adb, serial)
    const px = (value: number, max: number): string => String(Math.round(Math.max(0, Math.min(1, value)) * (max - 1)))
    if (action.kind === 'touch' && !TOUCH_PHASES.has(action.phase)) throw new Error('设备操作无效')
    if (action.kind === 'touch') input.send(`input motionevent ${action.phase.toUpperCase()} ${px(action.x, size.width)} ${px(action.y, size.height)}`, action.phase === 'move')
    else if (action.kind === 'tap') input.send(`input tap ${px(action.x, size.width)} ${px(action.y, size.height)}`)
    else input.send(`input swipe ${px(action.x, size.width)} ${px(action.y, size.height)} ${px(action.toX, size.width)} ${px(action.toY, size.height)} ${Math.round(action.ms ?? 300)}`)
  }

  private async screenSize(adb: string, serial: string): Promise<{ width: number; height: number }> {
    const { stdout } = await run(adb, ['-s', serial, 'shell', 'wm', 'size'], { windowsHide: true, timeout: 10_000 })
    const match = /(?:Override|Physical) size:\s*(\d+)x(\d+)/.exec(stdout.split(/\r?\n/).reverse().join('\n'))
    if (!match) throw new Error('无法读取设备屏幕尺寸')
    return { width: Number(match[1]), height: Number(match[2]) }
  }
}
