import { callHostTool, hostToolsAvailable, toolText } from './host-tool-call.js'

const DEVICE = { type: 'string', description: 'adb serial; only needed when several devices are connected' }
const SETTLE = {
  wait: { type: 'integer', minimum: 0, maximum: 10000, description: 'ms to wait before re-reading the screen (default 800)' },
  quiet: { type: 'boolean', description: 'skip the automatic re-read of the screen' }
}
const SETTLE_NOTE = ' Waits, then returns the refreshed screen elements (refs update).'

const PHONE_TOOLS = [
  {
    action: 'devices',
    description: 'List the Android phones connected over adb (USB or wireless debugging): serial, state, model.',
    properties: {}
  },
  {
    action: 'ui',
    description: 'Read the current screen of the user\'s Android phone as an element list, one per line: ref type "text" desc= id= (x,y) [actions]. Refs are used by phone_tap and phone_type.',
    properties: { device: DEVICE }
  },
  {
    action: 'screen',
    description: 'Screenshot the phone to a PNG and return its path; open it with the read tool. Coordinates match phone_tap x/y. Use when the UI tree is empty (games, video).',
    properties: { device: DEVICE }
  },
  {
    action: 'apps',
    description: 'List installed app package names on the phone, optionally filtered by query.',
    properties: { device: DEVICE, query: { type: 'string' } }
  },
  {
    action: 'launch',
    description: `Launch an app by package name.${SETTLE_NOTE}`,
    properties: { device: DEVICE, package: { type: 'string' }, ...SETTLE },
    required: ['package']
  },
  {
    action: 'tap',
    description: `Tap on the phone: target by ref (from the latest phone_ui), by text (exact match first, then contains; index picks among matches), or by x/y pixels. hold: long press in ms.${SETTLE_NOTE} This is the user's real phone: ask before payments, deletions, sending messages or changing system settings.`,
    properties: {
      device: DEVICE, ref: { type: 'string' }, text: { type: 'string' }, index: { type: 'integer', minimum: 1 },
      x: { type: 'number' }, y: { type: 'number' }, hold: { type: 'integer', minimum: 0 }, ...SETTLE
    }
  },
  {
    action: 'swipe',
    description: `Swipe on the phone: direction is the finger movement (up pushes content up, showing what is below), or from/to as "x,y" pixel pairs.${SETTLE_NOTE}`,
    properties: {
      device: DEVICE, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, from: { type: 'string' }, to: { type: 'string' },
      ms: { type: 'integer', minimum: 50, maximum: 5000 }, ...SETTLE
    }
  },
  {
    action: 'type',
    description: `Type text into the focused field (with ref: tap that field first). ASCII only (adb limit). enter: press Enter afterwards.${SETTLE_NOTE}`,
    properties: { device: DEVICE, text: { type: 'string' }, ref: { type: 'string' }, enter: { type: 'boolean' }, ...SETTLE },
    required: ['text']
  },
  {
    action: 'key',
    description: `Press a key: back, home, recents, enter, delete, tab, escape, menu, search, power, wake, volume_up, volume_down, up, down, left, right, or KEYCODE_*.${SETTLE_NOTE}`,
    properties: { device: DEVICE, key: { type: 'string' }, ...SETTLE },
    required: ['key']
  }
]

export function phoneResult(outcome) {
  if (!outcome.ok) return toolText(outcome.cancelled ? 'Phone action cancelled.' : `Phone action failed: ${outcome.error}`, { code: outcome.code }, !outcome.cancelled)
  return toolText(JSON.stringify(outcome.summary ?? {}), { summary: outcome.summary ?? {} })
}

export function createPhoneTools(call = callHostTool) {
  return PHONE_TOOLS.map(({ action, description, properties, required }) => ({
    name: `phone_${action}`,
    label: `Phone ${action}`,
    description,
    parameters: { type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false },
    exposure: 'deferred',
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return phoneResult(await call({ command: `phone.${action}`, params: params ?? {}, toolCallId, cwd: ctx?.cwd, signal }))
    }
  }))
}

export default function phoneTools(pi) {
  if (!hostToolsAvailable() || typeof pi.registerTool !== 'function') return
  for (const tool of createPhoneTools()) pi.registerTool(tool)
}
