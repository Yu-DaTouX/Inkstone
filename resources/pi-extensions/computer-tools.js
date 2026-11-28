import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { callHostTool, hostToolsAvailable, toolText } from './host-tool-call.js'

export const COMPUTER_USE_SERVER = 'windows-mcp'

export function computerUseEnabled(env = process.env) {
  try {
    const dir = env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    const file = env.YAN_MCP_SERVERS_FILE?.trim() || join(dir, 'mcp-servers.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : []
    return list.some((server) => server?.id === COMPUTER_USE_SERVER && server.enabled !== false)
  } catch {
    return false
  }
}

const POINT = { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[x, y] in virtual-desktop pixels' }
const LABEL = { type: 'integer', description: 'element label from the latest computer_snapshot' }
const TARGET = { loc: POINT, label: LABEL }
const AREA = {
  display: { type: 'array', items: { type: 'integer' }, description: 'zero-based display indices; omit for the whole desktop' },
  region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4, description: '[left, top, right, bottom] in virtual-desktop pixels; overrides display' }
}
const GRID = {
  width_reference_line: { type: 'integer', description: 'draw vertical grid lines on the image' },
  height_reference_line: { type: 'integer', description: 'draw horizontal grid lines on the image' }
}
const DESTRUCTIVE_NOTE = ' This is the user\'s real desktop: ask before sending, paying, deleting or changing system settings.'

const COMPUTER_TOOLS = [
  {
    action: 'snapshot',
    tool: 'Snapshot',
    description: 'Read the Windows desktop as text: focused and open windows, interactive elements with labels and (x,y) coordinates, scrollable areas. use_vision=true also attaches an annotated screenshot; use_dom=true reads web page content in a browser window instead of its browser UI.',
    properties: {
      use_vision: { type: 'boolean' },
      use_dom: { type: 'boolean' },
      use_annotation: { type: 'boolean', description: 'draw element boxes on the screenshot (default true)' },
      use_ui_tree: { type: 'boolean', description: 'false skips element extraction' },
      ...AREA,
      ...GRID
    }
  },
  {
    action: 'screenshot',
    tool: 'Screenshot',
    description: 'Screenshot the desktop, a display or a region without the UI tree. The image is saved to a file whose path is returned. It may be downscaled: multiply image coordinates by original/displayed size before clicking.',
    properties: { ...AREA, use_annotation: { type: 'boolean' }, ...GRID }
  },
  {
    action: 'displays',
    tool: 'DisplayInventory',
    description: 'List the displays: index, bounds, work area, resolution, primary flag, DPI and scale.',
    properties: {}
  },
  {
    action: 'click',
    tool: 'Click',
    description: `Click at loc or a snapshot label. clicks: 0 hovers, 1 single, 2 double.${DESTRUCTIVE_NOTE}`,
    properties: { ...TARGET, button: { type: 'string', enum: ['left', 'right', 'middle'] }, clicks: { type: 'integer', minimum: 0 } }
  },
  {
    action: 'type',
    tool: 'Type',
    description: `Click a field (loc or label) and type text. clear=true empties it first; caret_position start/end, or idle (where the click put the caret); press_enter submits.${DESTRUCTIVE_NOTE}`,
    properties: {
      text: { type: 'string' },
      ...TARGET,
      clear: { type: 'boolean' },
      caret_position: { type: 'string', enum: ['start', 'idle', 'end'] },
      press_enter: { type: 'boolean' }
    },
    required: ['text']
  },
  {
    action: 'scroll',
    tool: 'Scroll',
    description: 'Scroll at loc, a snapshot label, or the current mouse position. One wheel step is about 3-5 lines.',
    properties: {
      ...TARGET,
      type: { type: 'string', enum: ['vertical', 'horizontal'] },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      wheel_times: { type: 'integer', minimum: 1 }
    }
  },
  {
    action: 'move',
    tool: 'Move',
    description: `Move the mouse to loc or a snapshot label (hover). drag=true drags from the current position; from_loc makes the drag start explicit. duration in seconds.${DESTRUCTIVE_NOTE}`,
    properties: { ...TARGET, drag: { type: 'boolean' }, from_loc: POINT, duration: { type: 'number', minimum: 0 } }
  },
  {
    action: 'shortcut',
    tool: 'Shortcut',
    description: `Press a key or key combination joined by +, e.g. "enter", "ctrl+c", "alt+tab", "win+r".${DESTRUCTIVE_NOTE}`,
    properties: { shortcut: { type: 'string' } },
    required: ['shortcut']
  },
  {
    action: 'wait',
    tool: 'Wait',
    description: 'Wait a number of seconds for an app to load or an animation to finish.',
    properties: { duration: { type: 'integer', minimum: 1 } },
    required: ['duration']
  },
  {
    action: 'wait_for',
    tool: 'WaitFor',
    description: 'Wait until a UI condition holds, polling inside the tool instead of repeated snapshots. Give text and/or window_name as the condition needs.',
    properties: {
      condition: { type: 'string', enum: ['text_exists', 'active_window', 'element_exists', 'element_enabled', 'focused_element'] },
      text: { type: 'string' },
      window_name: { type: 'string' },
      timeout: { type: 'number', minimum: 0 },
      interval: { type: 'number', minimum: 0 },
      use_dom: { type: 'boolean' }
    },
    required: ['condition']
  },
  {
    action: 'app',
    tool: 'App',
    description: `Manage applications. mode launch opens an app by Start menu name; launch_executable runs one executable path with args and cwd; resize sets window_loc/window_size of a named or the active window; switch focuses a window by name.${DESTRUCTIVE_NOTE}`,
    properties: {
      mode: { type: 'string', enum: ['launch', 'launch_executable', 'resize', 'switch'] },
      name: { type: 'string' },
      executable: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      window_loc: POINT,
      window_size: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[width, height] in pixels' }
    }
  },
  {
    action: 'multi_select',
    tool: 'MultiSelect',
    description: 'Select several items (files, rows, checkboxes) by locs or labels; press_ctrl=false clicks them one by one without Ctrl.',
    properties: {
      locs: { type: 'array', items: POINT },
      labels: { type: 'array', items: { type: 'integer' } },
      press_ctrl: { type: 'boolean' }
    }
  },
  {
    action: 'multi_edit',
    tool: 'MultiEdit',
    description: `Fill several fields at once: locs=[[x, y, text], ...] or labels=[[label, text], ...].${DESTRUCTIVE_NOTE}`,
    properties: {
      locs: { type: 'array', items: { type: 'array', minItems: 3, maxItems: 3 } },
      labels: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2 } }
    }
  },
  {
    action: 'control',
    tool: 'ControlStatus',
    description: 'Show who controls the desktop (ai, user or ready). release=true hands the keyboard and mouse back to the user now; Inkstone also does this at turn end, before approvals or questions, and after 15 s without input actions.',
    properties: { release: { type: 'boolean' } }
  }
]

function unwrapText(text) {
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('["') || !line.endsWith('"]')) return line
      try {
        const parts = JSON.parse(line)
        return Array.isArray(parts) && parts.every((part) => typeof part === 'string') ? parts.join('\n') : line
      } catch {
        return line
      }
    })
    .join('\n')
}

export function computerResult(outcome) {
  if (!outcome.ok) return toolText(outcome.cancelled ? 'Computer action cancelled.' : `Computer action failed: ${outcome.error}`, { code: outcome.code }, !outcome.cancelled)
  const data = outcome.data ?? {}
  const text = typeof data.text === 'string' && data.text ? unwrapText(data.text) : JSON.stringify(outcome.summary ?? {})
  const details = { ...(Array.isArray(data.images) ? { images: data.images } : {}), ...(data.resultFile ? { resultFile: data.resultFile } : {}) }
  return toolText(text, details, data.toolError === true)
}

export function createComputerTools(call = callHostTool) {
  return COMPUTER_TOOLS.map(({ action, tool, description, properties, required }) => ({
    name: `computer_${action}`,
    label: `Computer ${action.replace('_', ' ')}`,
    description,
    parameters: { type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const request = { server: COMPUTER_USE_SERVER, tool, arguments: params ?? {}, via: `computer_${action}` }
      return computerResult(await call({ command: 'mcp.call', params: request, toolCallId, cwd: ctx?.cwd, signal }))
    }
  }))
}

export default function computerTools(pi) {
  if (process.platform !== 'win32' || !hostToolsAvailable() || typeof pi.registerTool !== 'function' || !computerUseEnabled()) return
  for (const tool of createComputerTools()) pi.registerTool(tool)
}
