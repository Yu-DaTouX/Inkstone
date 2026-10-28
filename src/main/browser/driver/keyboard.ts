export type KeyboardServices = {
  cdp(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>
  sleep(ms: number): Promise<void>
  platform?: string
}

export interface KeySpec {
  vk: number
  key: string
  code: string
  text: string
}

export const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8
} as const

export type ModifierName = keyof typeof MODIFIER_BITS

export interface KeyChord {
  key: string
  spec: KeySpec
  modifiers: number
  modifierKeys: ModifierName[]
}

const KEYS: Record<string, KeySpec> = {
  Enter: { vk: 13, key: 'Enter', code: 'Enter', text: '\r' },
  Tab: { vk: 9, key: 'Tab', code: 'Tab', text: '\t' },
  Backspace: { vk: 8, key: 'Backspace', code: 'Backspace', text: '' },
  Escape: { vk: 27, key: 'Escape', code: 'Escape', text: '' },
  Delete: { vk: 46, key: 'Delete', code: 'Delete', text: '' },
  ' ': { vk: 32, key: ' ', code: 'Space', text: ' ' },
  ArrowLeft: { vk: 37, key: 'ArrowLeft', code: 'ArrowLeft', text: '' },
  ArrowUp: { vk: 38, key: 'ArrowUp', code: 'ArrowUp', text: '' },
  ArrowRight: { vk: 39, key: 'ArrowRight', code: 'ArrowRight', text: '' },
  ArrowDown: { vk: 40, key: 'ArrowDown', code: 'ArrowDown', text: '' },
  Home: { vk: 36, key: 'Home', code: 'Home', text: '' },
  End: { vk: 35, key: 'End', code: 'End', text: '' },
  PageUp: { vk: 33, key: 'PageUp', code: 'PageUp', text: '' },
  PageDown: { vk: 34, key: 'PageDown', code: 'PageDown', text: '' },
  '/': { vk: 191, key: '/', code: 'Slash', text: '/' },
  '.': { vk: 190, key: '.', code: 'Period', text: '.' },
  ',': { vk: 188, key: ',', code: 'Comma', text: ',' },
  ';': { vk: 186, key: ';', code: 'Semicolon', text: ';' },
  '-': { vk: 189, key: '-', code: 'Minus', text: '-' },
  '=': { vk: 187, key: '=', code: 'Equal', text: '=' },
  '[': { vk: 219, key: '[', code: 'BracketLeft', text: '[' },
  ']': { vk: 221, key: ']', code: 'BracketRight', text: ']' },
  '\\': { vk: 220, key: '\\', code: 'Backslash', text: '\\' },
  "'": { vk: 222, key: "'", code: 'Quote', text: "'" },
  '`': { vk: 192, key: '`', code: 'Backquote', text: '`' }
}

const NAMED_KEYS = new Map(
  Object.keys(KEYS)
    .filter((name) => name.length > 1)
    .map((name) => [name.toLowerCase(), name])
)

const ARROW_ALIASES = new Map([
  ['left', 'ArrowLeft'],
  ['right', 'ArrowRight'],
  ['up', 'ArrowUp'],
  ['down', 'ArrowDown'],
  ['esc', 'Escape'],
  ['space', ' '],
  ['del', 'Delete']
])

const MODIFIER_ALIASES = new Map<string, ModifierName | 'ControlOrMeta'>([
  ['alt', 'Alt'],
  ['control', 'Control'],
  ['meta', 'Meta'],
  ['shift', 'Shift'],
  ['controlormeta', 'ControlOrMeta']
])

const MODIFIER_KEYS: { bit: number; key: string; code: string; windowsVirtualKeyCode: number; location: number }[] = [
  { bit: MODIFIER_BITS.Alt, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, location: 1 },
  { bit: MODIFIER_BITS.Control, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, location: 1 },
  { bit: MODIFIER_BITS.Meta, key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  { bit: MODIFIER_BITS.Shift, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 }
]

const PRINTABLE_CODE_RE = /^[A-Za-z0-9]$/
const NON_TEXT_MODIFIERS = MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta
const INPUT_EVENT_DELAY_MS = 25

export function keyDefinition(key: string): KeySpec {
  const special = KEYS[key]
  if (special) return special
  if (key.length !== 1) return { vk: 0, key, code: key, text: '' }
  const vk = key.toUpperCase().codePointAt(0) ?? 0
  const code = PRINTABLE_CODE_RE.test(key) ? `${/[0-9]/.test(key) ? 'Digit' : 'Key'}${key.toUpperCase()}` : key
  return { vk, key, code, text: key }
}

export function splitChord(chord: string): string[] {
  if (typeof chord !== 'string' || chord.length === 0) {
    throw new TypeError('按键组合不能为空')
  }
  const tokens: string[] = []
  let building = ''
  for (const character of chord) {
    if (character === '+' && building) {
      tokens.push(building)
      building = ''
    } else {
      building += character
    }
  }
  tokens.push(building)
  if (tokens.some((token) => token.length === 0)) {
    throw new TypeError(`按键组合格式无效：${chord}`)
  }
  return tokens
}

export function resolveSmartModifier(token: string, platform: string = process.platform): string {
  const normalized = MODIFIER_ALIASES.get(token.toLowerCase()) ?? NAMED_KEYS.get(token.toLowerCase()) ?? token
  if (normalized === 'ControlOrMeta') return platform === 'darwin' ? 'Meta' : 'Control'
  return normalized
}

export function parseKeyChord(chord: string, platform: string = process.platform): KeyChord {
  const modifierKeys: ModifierName[] = []
  let key: string | undefined
  for (const token of splitChord(chord)) {
    const name = resolveSmartModifier(token, platform)
    if (isModifierName(name)) {
      if (!modifierKeys.includes(name)) modifierKeys.push(name)
      continue
    }
    if (key !== undefined) {
      throw new TypeError(`按键组合只能有一个主键：${chord}`)
    }
    key = resolveKeyName(name)
  }
  if (key === undefined) {
    throw new TypeError(`按键组合缺少主键：${chord}`)
  }
  const spec = keyDefinition(key)
  const modifiers = modifierKeys.reduce((mask, name) => mask | MODIFIER_BITS[name], 0)
  return { key, spec, modifiers, modifierKeys }
}

export function formatChord(chord: string | KeyChord): string {
  const parsed = typeof chord === 'string' ? parseKeyChord(chord) : chord
  return [...parsed.modifierKeys, parsed.key].join('+')
}

function isModifierName(name: string): name is ModifierName {
  return Object.prototype.hasOwnProperty.call(MODIFIER_BITS, name)
}

function resolveKeyName(token: string): string {
  const named = NAMED_KEYS.get(token.toLowerCase())
  if (named) return named
  if (token.length === 1) return token
  const arrow = ARROW_ALIASES.get(token.toLowerCase())
  if (arrow) return arrow
  throw new TypeError(`未知按键：${token}`)
}

export interface PressOptions {
  sessionId?: string
  delay?: number
  platform?: string
}

export async function pressKey(services: KeyboardServices, chord: string, options: PressOptions = {}): Promise<void> {
  const platform = options.platform ?? services.platform ?? process.platform
  const parsed = parseKeyChord(chord, platform)
  const { spec, modifiers } = parsed
  const emittedText = modifiers & NON_TEXT_MODIFIERS ? '' : spec.text
  const base = { key: spec.key, code: spec.code, modifiers, windowsVirtualKeyCode: spec.vk }
  const pressedModifiers = MODIFIER_KEYS.filter((modifier) => Boolean(modifiers & modifier.bit))
  let activeModifiers = 0
  let finalKeyDownAttempted = false
  let dispatchError: unknown = null
  try {
    for (const modifier of pressedModifiers) {
      activeModifiers |= modifier.bit
      await dispatchKeyEvent(services, options.sessionId, {
        type: 'rawKeyDown',
        key: modifier.key,
        code: modifier.code,
        modifiers: activeModifiers,
        windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
        location: modifier.location
      })
    }
    finalKeyDownAttempted = true
    await dispatchKeyEvent(services, options.sessionId, {
      type: emittedText ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(emittedText ? { text: emittedText, unmodifiedText: emittedText } : {})
    })
    await services.sleep(options.delay ?? INPUT_EVENT_DELAY_MS)
    await dispatchKeyEvent(services, options.sessionId, { type: 'keyUp', ...base })
    finalKeyDownAttempted = false
  } catch (error) {
    dispatchError = error
  } finally {
    if (finalKeyDownAttempted) {
      try {
        await dispatchKeyEvent(services, options.sessionId, { type: 'keyUp', ...base })
      } catch (error) {
        dispatchError ??= error
      }
    }
    for (const modifier of [...pressedModifiers].reverse()) {
      activeModifiers &= ~modifier.bit
      try {
        await dispatchKeyEvent(services, options.sessionId, {
          type: 'keyUp',
          key: modifier.key,
          code: modifier.code,
          modifiers: activeModifiers,
          windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
          location: modifier.location
        })
      } catch (error) {
        dispatchError ??= error
      }
    }
  }
  if (dispatchError) throw dispatchError
}

export async function typeText(
  services: KeyboardServices,
  text: string,
  sessionId?: string
): Promise<void> {
  if (typeof text !== 'string') {
    throw new TypeError('输入文本必须是字符串')
  }
  await services.cdp('Input.insertText', { text }, sessionId)
}

async function dispatchKeyEvent(
  services: KeyboardServices,
  sessionId: string | undefined,
  params: Record<string, unknown>
): Promise<void> {
  await services.cdp('Input.dispatchKeyEvent', params, sessionId)
}
