import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const NATIVE_COMMAND = '__inkstone_native'
export const RECEIPT_PREFIX = '__inkstone_native_receipt__:'
export const ENVELOPE_VERSION = 1
const MAX_ARG_BYTES = 256 * 1024

export function resolveAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim()
  if (envDir) return resolve(envDir)
  return join(homedir(), '.pi', 'agent')
}

export function canonicalizeCwd(cwd) {
  const absolute = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function readJsonObject(file) {
  if (!existsSync(file)) return {}
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} 不是 JSON 对象，已拒绝覆盖`)
  }
  return parsed
}

function writeFileAtomic(file, text) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
    }
    throw error
  }
}

export function readTrustTable(file) {
  const raw = readJsonObject(file)
  const table = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value !== true && value !== false && value !== null) {
      throw new Error(`${file} 中 ${JSON.stringify(key)} 的值必须是 true / false / null`)
    }
    table[key] = value
  }
  return table
}

export function findNearestTrustEntry(table, cwd) {
  let current = canonicalizeCwd(cwd)
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(table, current)) {
      const decision = table[current]
      if (decision === true || decision === false) return { path: current, decision }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function saveTrustDecision(file, cwd, decision) {
  if (decision !== true && decision !== false && decision !== null) {
    throw new Error('decision 必须是 true / false / null')
  }
  const table = readTrustTable(file)
  const key = canonicalizeCwd(cwd)
  if (decision === null) delete table[key]
  else table[key] = decision
  const sorted = {}
  for (const name of Object.keys(table).sort()) sorted[name] = table[name]
  writeFileAtomic(file, `${JSON.stringify(sorted, null, 2)}\n`)
  return { entry: key, decision }
}

export function readEnabledModels(file) {
  const settings = readJsonObject(file)
  const patterns = settings.enabledModels
  if (patterns === undefined) return undefined
  if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== 'string')) {
    throw new Error(`${file} 的 enabledModels 必须是字符串数组`)
  }
  return patterns
}

export function writeEnabledModels(file, patterns) {
  const settings = readJsonObject(file)
  if (patterns === undefined || patterns === null || (Array.isArray(patterns) && patterns.length === 0)) {
    delete settings.enabledModels
  } else {
    if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error('patterns 必须是非空字符串数组')
    }
    settings.enabledModels = patterns.map((item) => item.trim())
  }
  writeFileAtomic(file, JSON.stringify(settings, null, 2))
  return { settingsFile: file, patterns: settings.enabledModels }
}

export function parseEnvelope(text) {
  const encoded = String(text ?? '').trim()
  if (!encoded) throw new Error('缺少参数')
  if (encoded.length > MAX_ARG_BYTES) throw new Error('参数过长')
  let json
  try {
    json = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch (error) {
    throw new Error(`参数不是合法 base64url：${error instanceof Error ? error.message : String(error)}`)
  }
  let envelope
  try {
    envelope = JSON.parse(json)
  } catch (error) {
    throw new Error(`参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('信封必须是对象')
  if (envelope.v !== ENVELOPE_VERSION) throw new Error(`信封版本不支持：${String(envelope.v)}`)
  if (envelope.host !== 'inkstone') throw new Error('调用方不是砚宿主')
  if (typeof envelope.id !== 'string' || !envelope.id) throw new Error('缺少 request id')
  if (typeof envelope.op !== 'string' || !envelope.op) throw new Error('缺少 op')
  return envelope
}

export function buildReceipt({ id, op, ok, result, error, phase }) {
  const payload = { v: ENVELOPE_VERSION, id, op, ok: ok === true }
  if (phase !== undefined) payload.phase = phase
  if (result !== undefined) payload.result = result
  if (error !== undefined && error !== null) {
    payload.error = typeof error === 'string' ? { message: error } : error
  }
  return `${RECEIPT_PREFIX}${JSON.stringify(payload)}`
}

export function parseReceipt(message) {
  const text = String(message ?? '')
  if (!text.startsWith(RECEIPT_PREFIX)) return null
  try {
    const parsed = JSON.parse(text.slice(RECEIPT_PREFIX.length))
    if (!parsed || typeof parsed !== 'object' || parsed.v !== ENVELOPE_VERSION) return null
    if (typeof parsed.id !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function scopedModelEntry(scoped) {
  const model = scoped?.model ?? {}
  return {
    provider: String(model.provider ?? ''),
    id: String(model.id ?? ''),
    name: String(model.name ?? model.id ?? ''),
    ...(scoped?.thinkingLevel ? { thinkingLevel: scoped.thinkingLevel } : {})
  }
}

export default function nativeSessionBridge(pi) {
  if (process.env.YAN_NATIVE_BRIDGE !== '1') return
  const hello = (ctx, reason) => {
    ctx.ui.notify(
      buildReceipt({
        id: `hello-${randomUUID()}`,
        op: 'hello',
        ok: true,
        result: {
          reason,
          version: ENVELOPE_VERSION,
          command: NATIVE_COMMAND,
          capabilities: ['navigate_tree', 'reload', 'scoped_models_read', 'scoped_models_set', 'trust_read', 'trust_save', 'navigate_tree_summary', 'set_label']
        }
      }),
      'info'
    )
  }

  pi.on('session_start', (_event, ctx) => {
    try {
      hello(ctx, _event?.reason ?? 'startup')
    } catch {
    }
  })

  pi.on('model_select', (event, ctx) => {
    try {
      ctx.ui.notify(
        buildReceipt({
          id: `model-${randomUUID()}`,
          op: 'model_select',
          ok: true,
          result: { provider: String(event?.model?.provider ?? ''), id: String(event?.model?.id ?? ''), source: String(event?.source ?? '') }
        }),
        'info'
      )
    } catch {
    }
  })

  async function dispatch(op, args, ctx) {
    switch (op) {
      case 'navigate_tree': {
        const targetId = String(args?.targetId ?? '')
        if (!targetId) throw new Error('缺少 targetId')
        const summarize = args?.summarize === true
        const outcome = await ctx.navigateTree(targetId, { summarize })
        const leafId = ctx.sessionManager.getLeafId()
        const branch = ctx.sessionManager.getBranch()
        return {
          cancelled: outcome?.cancelled === true,
          requestedTargetId: targetId,
          leafId,
          branchIds: Array.isArray(branch) ? branch.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
          sessionFile: ctx.sessionManager.getSessionFile()
        }
      }
      case 'set_label': {
        const targetId = String(args?.targetId ?? '')
        if (!targetId) throw new Error('缺少 targetId')
        const label = typeof args?.label === 'string' ? args.label.trim() : ''
        pi.setLabel(targetId, label || undefined)
        return { targetId, label: label || null }
      }
      case 'reload': {
        await ctx.reload()
        return { phase: 'completed', requestId: args?.__requestId ?? null }
      }
      case 'scoped_models_read': {
        const scoped = []
        try {
          for (const entry of ctx.scopedModels ?? []) scoped.push(scopedModelEntry(entry))
        } catch {
        }
        let enabledModels
        try {
          enabledModels = pi.getSettings?.().enabledModels
        } catch {
          enabledModels = undefined
        }
        return { scoped, ...(enabledModels === undefined ? {} : { enabledModels }) }
      }
      case 'scoped_models_set': {
        const file = join(resolveAgentDir(), 'settings.json')
        const saved = writeEnabledModels(file, args?.patterns)
        return {
          settingsFile: saved.settingsFile,
          patterns: saved.patterns ?? null,
          effective: 'next-session'
        }
      }
      case 'trust_read': {
        const file = join(resolveAgentDir(), 'trust.json')
        const cwd = String(args?.cwd ?? ctx.cwd ?? '')
        if (!cwd) throw new Error('缺少 cwd')
        const table = readTrustTable(file)
        const hit = findNearestTrustEntry(table, cwd)
        return { cwd: canonicalizeCwd(cwd), entry: hit?.path ?? null, decision: hit?.decision ?? null, ...(typeof ctx.isProjectTrusted === 'function' ? { effectiveTrusted: ctx.isProjectTrusted() } : {}) }
      }
      case 'trust_save': {
        const file = join(resolveAgentDir(), 'trust.json')
        const cwd = String(args?.cwd ?? ctx.cwd ?? '')
        if (!cwd) throw new Error('缺少 cwd')
        const decision = args?.decision
        const saved = saveTrustDecision(file, cwd, decision)
        return { cwd: canonicalizeCwd(cwd), entry: saved.entry, decision: saved.decision }
      }
      default:
        throw new Error(`未知操作：${op}`)
    }
  }

  pi.registerCommand(NATIVE_COMMAND, {
    description: 'Inkstone host bridge (internal)',
    handler: async (argText, ctx) => {
      let envelope
      try {
        envelope = parseEnvelope(argText)
      } catch (error) {
        ctx.ui.notify(
          buildReceipt({ id: '', op: 'unknown', ok: false, error: { code: 'bad_request', message: String(error?.message ?? error) } }),
          'error'
        )
        return
      }

      const ui = ctx.ui
      const { id, op, args } = envelope
      try {
        if (!ctx.isIdle()) {
          ui.notify(buildReceipt({ id, op, ok: false, error: { code: 'busy', message: '会话不空闲，宿主命令被拒绝' } }), 'warning')
          return
        }
        const result = await dispatch(op, { ...(args ?? {}), __requestId: id }, ctx)
        ui.notify(buildReceipt({ id, op, ok: true, result }), 'info')
      } catch (error) {
        ui.notify(
          buildReceipt({ id, op, ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } }),
          'error'
        )
      }
    }
  })
}
