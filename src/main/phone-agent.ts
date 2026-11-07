import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CapabilityCommandError, type CapabilityCommandResult } from './capability-server'
import { adbPath } from './android/android-paths'
import { inputText, parseAdbDevices } from './android/android-devices'

export interface PhoneElement {
  ref: string
  cls: string
  text: string
  desc: string
  id: string
  pkg: string
  x: number
  y: number
  bounds: [number, number, number, number]
  flags: string[]
}

export type AdbRunner = (args: string[], options: { binary?: boolean; timeoutMs?: number; signal?: AbortSignal }) => Promise<Buffer>

const ADB_TIMEOUT_MS = 20_000
const SETTLE_MS = 800
const WAIT_MAX_MS = 10_000
const SUMMARY_ELEMENTS = 150
const DUMP_PATH = '/sdcard/window_dump_inkstone.xml'

const KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  backspace: 'KEYCODE_DEL',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  menu: 'KEYCODE_MENU',
  search: 'KEYCODE_SEARCH',
  power: 'KEYCODE_POWER',
  wake: 'KEYCODE_WAKEUP',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT'
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export function parseUiDump(xml: string): PhoneElement[] {
  const out: PhoneElement[] = []
  for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = decodeXml(attr[2])
    const box = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds ?? '')
    if (!box) continue
    const bounds = [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])] as [number, number, number, number]
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue
    const cls = (attrs.class ?? '').split('.').pop() ?? ''
    const flags: string[] = []
    if (attrs.clickable === 'true') flags.push('click')
    if (attrs['long-clickable'] === 'true') flags.push('long')
    if (attrs.scrollable === 'true') flags.push('scroll')
    if (/EditText/.test(cls)) flags.push('edit')
    if (attrs.checkable === 'true') flags.push(attrs.checked === 'true' ? 'on' : 'off')
    if (attrs.selected === 'true') flags.push('selected')
    if (attrs.focused === 'true') flags.push('focused')
    if (attrs.enabled === 'false') flags.push('disabled')
    const text = (attrs.text ?? '').trim()
    const desc = (attrs['content-desc'] ?? '').trim()
    const interactive = flags.some((flag) => ['click', 'long', 'scroll', 'edit', 'on', 'off'].includes(flag))
    if (!text && !desc && !interactive) continue
    out.push({
      ref: `e${out.length + 1}`,
      cls,
      text,
      desc,
      id: (attrs['resource-id'] ?? '').replace(/^.*:id\//, ''),
      pkg: attrs.package ?? '',
      x: Math.round((bounds[0] + bounds[2]) / 2),
      y: Math.round((bounds[1] + bounds[3]) / 2),
      bounds,
      flags
    })
  }
  return out
}

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function elementLine(el: PhoneElement): string {
  const parts = [el.ref, el.cls || 'View']
  if (el.text) parts.push(JSON.stringify(clip(el.text)))
  if (el.desc && el.desc !== el.text) parts.push(`desc=${JSON.stringify(clip(el.desc))}`)
  if (el.id) parts.push(`id=${el.id}`)
  parts.push(`(${el.x},${el.y})`)
  if (el.flags.length) parts.push(`[${el.flags.join(' ')}]`)
  return parts.join(' ')
}

export function findByText(elements: readonly PhoneElement[], query: string): PhoneElement[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const exact = elements.filter((el) => el.text.toLowerCase() === q || el.desc.toLowerCase() === q)
  return exact.length ? exact : elements.filter((el) => el.text.toLowerCase().includes(q) || el.desc.toLowerCase().includes(q))
}

export function swipePoints(direction: string, width: number, height: number): [number, number, number, number] | null {
  const cx = Math.round(width / 2)
  const cy = Math.round(height / 2)
  const dy = Math.round(height * 0.3)
  const dx = Math.round(width * 0.3)
  if (direction === 'up') return [cx, cy + dy, cx, cy - dy]
  if (direction === 'down') return [cx, cy - dy, cx, cy + dy]
  if (direction === 'left') return [cx + dx, cy, cx - dx, cy]
  if (direction === 'right') return [cx - dx, cy, cx + dx, cy]
  return null
}

export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return null
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function num(params: Record<string, unknown>, key: string): number | null {
  const raw = str(params, key).trim()
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function point(raw: string, name: string): [number, number] {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw)
  if (!match) throw new CapabilityCommandError('phone_bad_args', `--${name} 要写成 x,y（像素），例如 --${name} 540,1600`)
  return [Math.round(Number(match[1])), Math.round(Number(match[2]))]
}

function defaultRunner(): AdbRunner {
  return (args, options) => new Promise((resolve, reject) => {
    const adb = adbPath() ?? 'adb'
    execFile(adb, args, { encoding: 'buffer', windowsHide: true, timeout: options.timeoutMs ?? ADB_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal: options.signal }, (error, stdout, stderr) => {
      if (error) {
        const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : ''
        const code = (error as NodeJS.ErrnoException).code
        reject(new CapabilityCommandError(code === 'ENOENT' ? 'phone_adb_missing' : 'phone_adb_failed',
          code === 'ENOENT' ? '没有找到 adb：请在设置 › 工具 › 安卓开发里安装 Platform-Tools，或把 adb 加到 PATH' : `adb ${args.filter((a) => a !== '-s').slice(1, 4).join(' ')} 失败：${detail || error.message}`))
        return
      }
      resolve(stdout as Buffer)
    })
  })
}

export class PhoneAgentCommands {
  private readonly cache = new Map<string, PhoneElement[]>()
  private readonly sizes = new Map<string, { width: number; height: number }>()

  constructor(private readonly opts: { opsDir: () => string; adb?: AdbRunner; sleep?: (ms: number) => Promise<void> }) {}

  private get adb(): AdbRunner {
    return this.opts.adb ?? defaultRunner()
  }

  async run(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    if (action === 'devices') return this.devices(signal)
    const serial = await this.pickDevice(str(params, 'device').trim(), signal)
    switch (action) {
      case 'ui': return this.ui(serial, signal)
      case 'screen': return this.screen(serial, signal)
      case 'apps': return this.apps(serial, str(params, 'query'), signal)
      case 'tap': return this.tap(serial, params, signal)
      case 'swipe': return this.swipe(serial, params, signal)
      case 'type': return this.type(serial, params, signal)
      case 'key': return this.key(serial, params, signal)
      case 'launch': return this.launch(serial, params, signal)
      default: throw new CapabilityCommandError('phone_unknown_action', `未知的 phone 动作：${action}（用 yan phone --help 查看）`)
    }
  }

  private shell(serial: string, command: string, signal?: AbortSignal, binary = false): Promise<Buffer> {
    return this.adb(['-s', serial, binary ? 'exec-out' : 'shell', command], { signal, binary })
  }

  private async devices(signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const list = parseAdbDevices((await this.adb(['devices', '-l'], { signal })).toString('utf8'))
    return { summary: { kind: 'phone', action: 'devices', count: list.length, devices: list }, data: { devices: list } }
  }

  private async pickDevice(requested: string, signal?: AbortSignal): Promise<string> {
    const list = parseAdbDevices((await this.adb(['devices', '-l'], { signal })).toString('utf8'))
    if (requested) {
      const hit = list.find((device) => device.serial === requested)
      if (!hit) throw new CapabilityCommandError('phone_device_missing', `没有连着序列号为 ${requested} 的设备；用 yan phone devices 查看`)
      if (hit.state !== 'device') throw new CapabilityCommandError('phone_device_unready', `设备 ${requested} 当前状态是 ${hit.state}（未授权时请让用户在手机上允许 USB 调试）`)
      return requested
    }
    const ready = list.filter((device) => device.state === 'device')
    if (ready.length === 1) return ready[0].serial
    if (!ready.length) throw new CapabilityCommandError('phone_no_device', list.length ? `设备都不可用：${list.map((d) => `${d.serial}(${d.state})`).join('、')}` : '没有连着的安卓设备：请用户用 USB 或无线调试连上手机，并在手机上允许调试')
    throw new CapabilityCommandError('phone_device_ambiguous', `连着多台设备，用 --device 指定：${ready.map((d) => `${d.serial}${d.model ? `（${d.model}）` : ''}`).join('、')}`, { devices: ready })
  }

  private async screenSize(serial: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    const cached = this.sizes.get(serial)
    if (cached) return cached
    const out = (await this.shell(serial, 'wm size', signal)).toString('utf8')
    const match = /(?:Override|Physical) size:\s*(\d+)x(\d+)/.exec(out.split(/\r?\n/).reverse().join('\n'))
    if (!match) throw new CapabilityCommandError('phone_size_failed', '读不到屏幕尺寸')
    const size = { width: Number(match[1]), height: Number(match[2]) }
    this.sizes.set(serial, size)
    return size
  }

  private async dump(serial: string, signal?: AbortSignal): Promise<PhoneElement[]> {
    const out = (await this.shell(serial, `uiautomator dump ${DUMP_PATH} >/dev/null 2>&1; cat ${DUMP_PATH}; rm -f ${DUMP_PATH}`, signal, true)).toString('utf8')
    if (!out.includes('<hierarchy')) {
      throw new CapabilityCommandError('phone_ui_failed', `读取界面结构失败${out.trim() ? `：${clip(out.trim(), 200)}` : ''}。界面在播动画或是游戏、视频等画面时常读不到，改用 yan phone screen 截图看`)
    }
    const elements = parseUiDump(out)
    this.cache.set(serial, elements)
    return elements
  }

  private async observe(serial: string, action: string, extra: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const elements = await this.dump(serial, signal)
    const lines = elements.map(elementLine)
    const app = elements.find((el) => el.pkg)?.pkg ?? ''
    return {
      summary: {
        kind: 'phone',
        action,
        device: serial,
        ...extra,
        app,
        count: elements.length,
        elements: lines.slice(0, SUMMARY_ELEMENTS).join('\n'),
        ...(lines.length > SUMMARY_ELEMENTS ? { truncated: `只列前 ${SUMMARY_ELEMENTS} 个，全部在 resultFile 里` } : {})
      },
      data: { device: serial, app, elements }
    }
  }

  private ui(serial: string, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    return this.observe(serial, 'ui', {}, signal)
  }

  private async screen(serial: string, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const data = await this.shell(serial, 'screencap -p', signal, true)
    const size = pngSize(data)
    if (!size) throw new CapabilityCommandError('phone_screen_failed', '截图失败：设备没有返回 PNG（锁屏或安全界面可能禁止截图）')
    const dir = this.opts.opsDir()
    const path = join(dir, `phone-${randomUUID()}.png`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, data)
    return { summary: { kind: 'phone', action: 'screen', device: serial, path, width: size.width, height: size.height, hint: '用 read 工具打开 path 查看；坐标与 tap --x/--y 同一像素系' }, data: { path, ...size } }
  }

  private async apps(serial: string, query: string, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const out = (await this.shell(serial, 'pm list packages', signal)).toString('utf8')
    const q = query.trim().toLowerCase()
    const packages = out.split(/\r?\n/).map((line) => line.replace(/^package:/, '').trim()).filter((name) => name && (!q || name.toLowerCase().includes(q))).sort()
    return { summary: { kind: 'phone', action: 'apps', device: serial, count: packages.length, packages: packages.slice(0, 200).join('\n') }, data: { packages } }
  }

  private async settle(serial: string, action: string, params: Record<string, unknown>, extra: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const wait = Math.max(0, Math.min(WAIT_MAX_MS, num(params, 'wait') ?? SETTLE_MS))
    await (this.opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(wait)
    if (params.quiet === true || str(params, 'quiet') === 'true') return { summary: { kind: 'phone', action, device: serial, ...extra } }
    try {
      return await this.observe(serial, action, extra, signal)
    } catch (error) {
      if (!(error instanceof CapabilityCommandError) || error.code !== 'phone_ui_failed') throw error
      return { summary: { kind: 'phone', action, device: serial, ...extra, observe: error.message } }
    }
  }

  private async target(serial: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ x: number; y: number; element?: PhoneElement; matches?: number }> {
    const ref = str(params, 'ref').trim()
    const text = str(params, 'text')
    const x = num(params, 'x')
    const y = num(params, 'y')
    if (ref) {
      const cached = this.cache.get(serial)
      if (!cached) throw new CapabilityCommandError('phone_no_snapshot', '还没有界面快照：先运行 yan phone ui，再用里面的 ref')
      const element = cached.find((el) => el.ref === ref)
      if (!element) throw new CapabilityCommandError('phone_stale_ref', `没有 ${ref}：界面可能已变化，重新运行 yan phone ui`)
      return { x: element.x, y: element.y, element }
    }
    if (text.trim()) {
      const hits = findByText(await this.dump(serial, signal), text)
      if (!hits.length) throw new CapabilityCommandError('phone_text_missing', `界面上没有找到“${clip(text, 40)}”；用 yan phone ui 看当前元素`)
      const index = Math.max(1, Math.round(num(params, 'index') ?? 1))
      const element = hits[Math.min(index, hits.length) - 1]
      return { x: element.x, y: element.y, element, matches: hits.length }
    }
    if (x !== null && y !== null) return { x: Math.round(x), y: Math.round(y) }
    throw new CapabilityCommandError('phone_bad_args', 'tap 需要 --ref、--text 或 --x 与 --y 之一')
  }

  private async tap(serial: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const hit = await this.target(serial, params, signal)
    const hold = num(params, 'hold')
    await this.shell(serial, hold && hold > 0 ? `input swipe ${hit.x} ${hit.y} ${hit.x} ${hit.y} ${Math.round(Math.min(hold, 5000))}` : `input tap ${hit.x} ${hit.y}`, signal)
    return this.settle(serial, 'tap', params, { tapped: hit.element ? elementLine(hit.element) : `(${hit.x},${hit.y})`, ...(hit.matches && hit.matches > 1 ? { matches: hit.matches } : {}) }, signal)
  }

  private async swipe(serial: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const ms = Math.round(Math.max(50, Math.min(5000, num(params, 'ms') ?? 300)))
    const direction = str(params, 'direction').trim().toLowerCase()
    let points: [number, number, number, number] | null
    if (direction) {
      const size = await this.screenSize(serial, signal)
      points = swipePoints(direction, size.width, size.height)
      if (!points) throw new CapabilityCommandError('phone_bad_args', '--direction 只能是 up / down / left / right（手指移动方向）')
    } else {
      const from = str(params, 'from')
      const to = str(params, 'to')
      if (!from || !to) throw new CapabilityCommandError('phone_bad_args', 'swipe 需要 --direction，或 --from x,y 与 --to x,y')
      points = [...point(from, 'from'), ...point(to, 'to')]
    }
    await this.shell(serial, `input swipe ${points.join(' ')} ${ms}`, signal)
    return this.settle(serial, 'swipe', params, { from: `${points[0]},${points[1]}`, to: `${points[2]},${points[3]}` }, signal)
  }

  private async type(serial: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const text = str(params, 'text')
    if (!/^[\x20-\x7e]*$/.test(text)) {
      throw new CapabilityCommandError('phone_text_unsupported', 'adb 只能输入英文、数字和半角符号；中文等请让用户在手机上输入，或先把文字复制到手机剪贴板后用长按粘贴')
    }
    if (str(params, 'ref').trim()) {
      const hit = await this.target(serial, params, signal)
      await this.shell(serial, `input tap ${hit.x} ${hit.y}`, signal)
    }
    if (text) await this.shell(serial, `input text ${inputText(text)}`, signal)
    if (params.enter === true || str(params, 'enter') === 'true') await this.shell(serial, 'input keyevent KEYCODE_ENTER', signal)
    return this.settle(serial, 'type', params, { typed: text.length }, signal)
  }

  private async key(serial: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const raw = str(params, 'key').trim()
    const name = raw.toLowerCase()
    const code = KEYS[name] ?? (/^KEYCODE_[A-Z0-9_]+$/.test(raw) ? raw : /^\d{1,3}$/.test(raw) ? raw : '')
    if (!code) throw new CapabilityCommandError('phone_bad_args', `不认识的按键：${raw}。可用：${Object.keys(KEYS).join(' ')}，或 KEYCODE_* 名称`)
    await this.shell(serial, `input keyevent ${code}`, signal)
    return this.settle(serial, 'key', params, { key: code }, signal)
  }

  private async launch(serial: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandResult> {
    const pkg = str(params, 'package').trim()
    if (!/^[A-Za-z][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(pkg)) throw new CapabilityCommandError('phone_bad_args', 'launch 需要 --package <包名>，例如 com.tencent.mm；不知道包名先用 yan phone apps --query <关键词>')
    const out = (await this.shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, signal)).toString('utf8')
    if (/No activities found|monkey aborted/i.test(out)) throw new CapabilityCommandError('phone_launch_failed', `启动 ${pkg} 失败：没有可启动的入口（包名不对或应用未安装）`)
    return this.settle(serial, 'launch', { ...params, wait: params.wait ?? '1500' }, { package: pkg }, signal)
  }
}
