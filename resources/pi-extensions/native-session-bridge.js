/*
 * 砚内置「原生会话桥」薄层 —— 让宿主**唯一**能触达 pi 的两个命令级原生能力：
 * `ctx.navigateTree()` 与 `ctx.reload()`，并补齐没有扩展公共 API 的两类读写。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须是扩展
 * ══════════════════════════════════════════════════════════════════
 * pi 1.2.0 里 `navigateTree` / `reload` 只挂在 `ExtensionCommandContext` 上
 * （见官方文档 extensions.md「Context and session changes」）。它们和生命周期
 * 钩子里那些会死锁，所以 pi 只把入口交给**命令处理器**。RPC 模式没有对应
 * 的原生命令，砚若想在桌面上用它们，只能由宿主发起一个命令、扩展在命令处理器
 * 里代调 —— 这就是本文件存在的全部理由。
 *
 * ── 调用通道（宿主 → pi）──
 *   宿主用现有 RPC `prompt` 发 `/__inkstone_native <base64url(JSON)>`。
 *   pi 会把以 `/` 开头的输入先交给扩展命令表；命中后不会进入模型上下文，
 *   响应里的 `disposition` 是 `handled`。参数用 base64url，避免空白、换行、
 *   引号参与 pi 的参数切分。
 *
 * ── 回执通道（pi → 宿主）──
 *   结果用 `ctx.ui.notify('<RECEIPT_PREFIX>' + JSON, ...)` 发出。RPC 模式下
 *   notify 是一条不需要应答的 `extension_ui_request`，宿主协议层把它当 `ui`
 *   事件抛出，宿主按前缀截获并解析，不展示给用户。request id 由宿主生成、
 *   放在回执里，宿主据此和自己的 Promise 对上。
 *
 * ── 边界（别扩写）──
 *   · 只注册一个**宿主专用**命令，不注册任何模型工具，不把命令交给模型；
 *   · `trust_save` 绝不由模型触发：它只在宿主显式确认后调用（IPC 层先走
 *     approval 面板），且本扩展只由宿主用 `--extension` 显式加载；
 *   · `navigate_tree` 固定 `summarize:false`：树导航不自动发起模型摘要；
 *   · 写入严格沿用 pi 自己的文件格式（`settings.json` / `trust.json`），
 *     不自造第二套状态；写盘用 tmp + rename，避免断电留下半份 JSON；
 *   · 读不到 / 版本不支持时如实回执错误，不返回假成功。
 *
 * 这些导出的纯函数也供 `scripts/test-native-session-runtime.mjs` 定向检查；
 * 默认导出才是 pi 的扩展工厂。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 宿主专用命令名（前缀 `__` 表明非用户命令）。 */
export const NATIVE_COMMAND = '__inkstone_native'
/** 回执前缀：宿主只截获以它开头的 notify，其余通知照常走原通道。 */
export const RECEIPT_PREFIX = '__inkstone_native_receipt__:'
/** 回执 / 请求信封版本。宿主与扩展各自校验，版本不一致直接报错。 */
export const ENVELOPE_VERSION = 1
/** 命令参数只接受 base64url，长度上限防止异常大 payload 撑爆内存。 */
const MAX_ARG_BYTES = 256 * 1024

/** pi 的 agent 目录：与 pi 自己一致，优先 `PI_CODING_AGENT_DIR`。 */
export function resolveAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim()
  if (envDir) return resolve(envDir)
  return join(homedir(), '.pi', 'agent')
}

/**
 * 与 pi `utils/paths.ts` 的 `canonicalizePath(resolvePath(cwd))` 同一口径：
 * 先绝对化，再 realpath（目录不存在就退回绝对路径）。trust.json 的键就是它。
 */
export function canonicalizeCwd(cwd) {
  const absolute = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** 读 JSON 对象文件；不存在返回 `{}`，格式非法抛错（不静默覆盖坏文件）。 */
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

/** tmp + rename 原子写；目录不存在时先建。 */
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
      /* 清理失败不改变原始错误 */
    }
    throw error
  }
}

/* ────────────────────────── trust.json（官方格式）────────────────────────── */

/**
 * pi 的 trust.json：`{ "<规范化绝对路径>": true | false | null }`。
 * 校验规则照抄 `core/trust-manager.js` 的 `readTrustFile`：值只能是这三种。
 */
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

/** pi 的「从 cwd 沿父目录向上找第一个条目」规则（`findNearestTrustEntry`）。 */
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

/**
 * 保存一个目录的信任决定。沿用 pi `writeTrustFile` 的写法：键排序、2 空格缩进、
 * 末尾换行；`decision === null` 表示删除该条目（回到「未表态」）。
 */
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

/* ──────────────────── settings.json 的 enabledModels（官方格式）──────────────────── */

/**
 * 读取用户级 `enabledModels`（scoped models 的原始 pattern 列表）。
 * 只读用户级设置 —— 项目级 `.pi/settings.json` 受信任闸门保护，桥不碰。
 */
export function readEnabledModels(file) {
  const settings = readJsonObject(file)
  const patterns = settings.enabledModels
  if (patterns === undefined) return undefined
  if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== 'string')) {
    throw new Error(`${file} 的 enabledModels 必须是字符串数组`)
  }
  return patterns
}

/**
 * 写用户级 `enabledModels`，保留文件里其它键。pi 自己落盘时也是这样整体重写的
 * （`JSON.stringify(settings, null, 2)`），所以格式与它一致。
 *
 * 注意边界：它只改**持久化设置**，不会改变当前 pi 进程已经解析好的 scopedModels。
 * 生效时机是下一次会话 / 进程启动。
 */
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

/* ────────────────────────────── 信封编解码 ───────────────────────────── */

/** 解析宿主发来的 base64url JSON 信封；非法输入抛错。 */
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

/** 组装回执文本。`result` / `error` 只保留可 JSON 序列化的内容。 */
export function buildReceipt({ id, op, ok, result, error, phase }) {
  const payload = { v: ENVELOPE_VERSION, id, op, ok: ok === true }
  if (phase !== undefined) payload.phase = phase
  if (result !== undefined) payload.result = result
  if (error !== undefined && error !== null) {
    payload.error = typeof error === 'string' ? { message: error } : error
  }
  return `${RECEIPT_PREFIX}${JSON.stringify(payload)}`
}

/** 从 notify 文本里解析回执；不是本桥回执返回 null。 */
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

/** 把 pi 的 Model 对象收敛成可 JSON 的 scoped 条目。 */
function scopedModelEntry(scoped) {
  const model = scoped?.model ?? {}
  return {
    provider: String(model.provider ?? ''),
    id: String(model.id ?? ''),
    name: String(model.name ?? model.id ?? ''),
    ...(scoped?.thinkingLevel ? { thinkingLevel: scoped.thinkingLevel } : {})
  }
}

/** 默认导出：pi 扩展工厂。 */
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
          capabilities: ['navigate_tree', 'reload', 'scoped_models_read', 'scoped_models_set', 'trust_read', 'trust_save']
        }
      }),
      'info'
    )
  }

  /* 新进程 / reload 后重新报到一次；宿主据此把桥标记为可用。 */
  pi.on('session_start', (_event, ctx) => {
    try {
      hello(ctx, _event?.reason ?? 'startup')
    } catch {
      /* 报到失败只影响宿主是否放行命令，不影响会话本身 */
    }
  })

  /**
   * 处理一个原生操作。返回给宿主的 result / error 都是纯数据。
   * `ctx` 是命令上下文，含 waitForIdle / navigateTree / reload。
   */
  async function dispatch(op, args, ctx) {
    switch (op) {
      case 'navigate_tree': {
        const targetId = String(args?.targetId ?? '')
        if (!targetId) throw new Error('缺少 targetId')
        /*
         * 固定 summarize:false —— 宿主只做「跳到某条」，摘要属于模型行为，
         * 不能由树导航悄悄发起。
         */
        const outcome = await ctx.navigateTree(targetId, { summarize: false })
        const leafId = ctx.sessionManager.getLeafId()
        const branch = ctx.sessionManager.getBranch()
        return {
          cancelled: outcome?.cancelled === true,
          requestedTargetId: targetId,
          leafId,
          /* 当前实际分支（叶子到根）的条目 id，宿主据此刷新界面分支标记。 */
          branchIds: Array.isArray(branch) ? branch.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
          sessionFile: ctx.sessionManager.getSessionFile()
        }
      }
      case 'reload': {
        /*
         * `ctx.reload()` 一开始就会把旧 ctx / pi 标记为 stale，await 之后再碰
         * ctx 会抛「stale after reload」。handler 已在外层捕获 ui，这里只做
         * reload 本身，完成回执由外层用捕获的 ui 发出。
         */
        await ctx.reload()
        return { phase: 'completed', requestId: args?.__requestId ?? null }
      }
      case 'scoped_models_read': {
        const scoped = []
        try {
          for (const entry of ctx.scopedModels ?? []) scoped.push(scopedModelEntry(entry))
        } catch {
          /* 读不到就返回空数组，由宿主显示「当前无 scoped」，不编造 */
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
          /* 诚实标注生效范围：当前运行时不会被这条命令改写。 */
          effective: 'next-session'
        }
      }
      case 'trust_read': {
        const file = join(resolveAgentDir(), 'trust.json')
        /* 不传 cwd 时用 pi 自己的当前工作目录 —— 宿主不需要另拿一份 cwd。 */
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
        /*
         * 连 id 都解析不出时也无法定向回执，只能按空 id 发一条，宿主对不上就直接忽略。
         */
        ctx.ui.notify(
          buildReceipt({ id: '', op: 'unknown', ok: false, error: { code: 'bad_request', message: String(error?.message ?? error) } }),
          'error'
        )
        return
      }

      /* reload 完成后旧 ctx 失效，只有这里提前捕获的 ui 还能发最终回执。 */
      const ui = ctx.ui
      const { id, op, args } = envelope
      try {
        if (!ctx.isIdle()) {
          ui.notify(buildReceipt({ id, op, ok: false, error: { code: 'busy', message: '会话不空闲，宿主命令被拒绝' } }), 'warning')
          return
        }
        /* reload 需要把 request id 带进 await 之后的分支。 */
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
