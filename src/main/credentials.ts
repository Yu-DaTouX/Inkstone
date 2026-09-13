/**
 * 模型接入 —— 读/写 pi 的凭证，让用户在桌面端就能配 API key。
 *
 * ══════════════════════════════════════════════════════════════════
 * 凭证从哪来（pi 的实际机制，读 docs/providers.md 得到）
 * ══════════════════════════════════════════════════════════════════
 * 解析顺序（后面覆盖前面）：
 *   ① 环境变量（如 `DEEPSEEK_API_KEY`）
 *   ② `~/.pi/agent/auth.json`（**优先于环境变量**）
 *
 * auth.json 的形状：
 * ```json
 * {
 *   "commandcode": { "type": "api_key", "key": "user_..." },
 *   "deepseek":    { "type": "api_key", "key": "sk-..." }
 * }
 * ```
 * OAuth 订阅（ChatGPT Plus/Pro、Claude Pro/Max、GitHub Copilot、xAI、
 * OpenRouter、Radius）的 token 也存这里，但**只能由 pi 的交互式 `/login` 生成** ——
 * RPC 模式没有 login 命令（查过 docs/rpc.md 的 47 个命令，确认没有）。
 * 所以本模块对订阅制只做「状态展示 + 告诉用户怎么做」，**不假装能代劳**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要写这个（而 README 里说「不碰 pi 的 settings.json」）
 * ══════════════════════════════════════════════════════════════════
 * settings.json 是**行为配置**（工具开关、主题等），桌面端去改会污染 TUI 的体验。
 * 而 auth.json 是**凭证**，它本来就是一个「用户手动往里放 key」的文件，
 * 桌面端提供输入框只是把它变成 GUI —— 与 TUI 的 `/login` 是同一件事。
 * 而且写入时会**合并**（不会碰其它 provider 的条目）。
 */
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { AuthProviderInfo, AuthStatus } from '../shared/ipc'
import { PI_AGENT_DIR } from './paths'

/**
 * pi 的凭证文件。
 *
 * ⚠️ `YAN_PI_DIR` 可覆盖 —— **测试必须用隔离目录**。
 *   这个项目已经因为「测试写真实用户数据」踩过两次（会话目录、记忆文件）。
 *   auth.json 里是用户的**真实密钥**，写坏了比那两个严重得多。
 */
const PI_DIR = PI_AGENT_DIR
const AUTH_FILE = join(PI_DIR, 'auth.json')

/** 只供主进程服务使用；密钥绝不跨 IPC 返回渲染层。 */
export async function resolveProviderSecret(provider: string): Promise<string | undefined> {
  const envNames: Record<string, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    commandcode: 'COMMANDCODE_API_KEY',
    openai: 'OPENAI_API_KEY',
    'openai-codex': 'OPENAI_API_KEY'
  }
  let fromFile: string | undefined
  try {
    const data = JSON.parse(await readFile(AUTH_FILE, 'utf8')) as Record<string, unknown>
    const entry = data[provider] as { key?: unknown; access?: unknown; access_token?: unknown } | string | undefined
    if (typeof entry === 'string') fromFile = entry
    else if (entry && typeof entry.key === 'string') fromFile = entry.key
    else if (entry && typeof entry.access === 'string') fromFile = entry.access
    else if (entry && typeof entry.access_token === 'string') fromFile = entry.access_token
  } catch { /* 未配置 */ }
  return fromFile || process.env[envNames[provider] ?? '']
}

/**
 * ChatGPT（Codex）订阅的 account id。
 *
 * 它的用量接口要求 `chatgpt-account-id` 头，而这个值只存在 auth.json 的
 * OAuth 条目里（与 access token 同源），所以放在这里统一读 ——
 * 不让 quota.ts 自己再拼一遍路径（那样两处迟早会读到不同的文件）。
 */
export async function resolveCodexAccountId(): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(AUTH_FILE, 'utf8')) as Record<string, unknown>
    const entry = data['openai-codex'] as { accountId?: unknown } | undefined
    return typeof entry?.accountId === 'string' ? entry.accountId : undefined
  } catch {
    return undefined
  }
}

/**
 * 接入方式一览。
 *
 * 数据来源：pi 的 `docs/providers.md`（订阅表 + API key 表）。
 * 这里**刻意只放常见的**，不放全部 35 个 —— 一屏能读完比「完整」有用。
 * 其余 provider 依然可用（pi 自己认识它们），只是不在这里给引导。
 */
const CATALOG: Omit<AuthProviderInfo, 'status'>[] = [
  // ---- 订阅制（OAuth，需要 pi 的交互式 /login） ----
  {
    id: 'openai-codex',
    name: 'ChatGPT Plus / Pro',
    kind: 'subscription',
    hint: '用你的 ChatGPT 订阅额度（Codex）',
    envVar: '',
    authKey: '',
    loginCmd: 'pi'
  },
  {
    id: 'anthropic',
    name: 'Claude Pro / Max',
    kind: 'subscription',
    hint: 'Anthropic 第三方客户端按 token 计费，不占用 Claude 套餐额度',
    envVar: 'ANTHROPIC_API_KEY',
    authKey: 'anthropic',
    loginCmd: 'pi'
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    kind: 'subscription',
    hint: '用 Copilot 订阅；企业版可填自建域名',
    envVar: '',
    authKey: '',
    loginCmd: 'pi'
  },
  { id: 'xai', name: 'xAI（Grok / X 订阅）', kind: 'subscription', hint: '', envVar: 'XAI_API_KEY', authKey: 'xai', loginCmd: 'pi' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'subscription',
    hint: 'OAuth 登录后会签发一个属于你的 API key（按 OpenRouter 余额计费）',
    envVar: 'OPENROUTER_API_KEY',
    authKey: 'openrouter',
    loginCmd: 'pi'
  },

  // ---- API key ----
  {
    id: 'commandcode',
    name: 'Command Code',
    kind: 'api_key',
    hint: '订阅套餐（按 5 小时 / 每周滚动额度计费）',
    envVar: 'COMMANDCODE_API_KEY',
    authKey: 'commandcode'
  },
  { id: 'deepseek', name: 'DeepSeek', kind: 'api_key', hint: '', envVar: 'DEEPSEEK_API_KEY', authKey: 'deepseek' },
  { id: 'openai', name: 'OpenAI', kind: 'api_key', hint: '', envVar: 'OPENAI_API_KEY', authKey: 'openai' },
  { id: 'google', name: 'Google Gemini', kind: 'api_key', hint: '', envVar: 'GEMINI_API_KEY', authKey: 'google' },
  { id: 'zai-coding-cn', name: 'ZAI 编程套餐（国内）', kind: 'api_key', hint: '', envVar: 'ZAI_CODING_CN_API_KEY', authKey: 'zai-coding-cn' },
  { id: 'kimi-coding', name: 'Kimi For Coding', kind: 'api_key', hint: '', envVar: 'KIMI_API_KEY', authKey: 'kimi-coding' },
  { id: 'minimax-cn', name: 'MiniMax（国内）', kind: 'api_key', hint: '', envVar: 'MINIMAX_CN_API_KEY', authKey: 'minimax-cn' },
  { id: 'qwen-token-plan-cn', name: 'Qwen Token Plan（国内）', kind: 'api_key', hint: '', envVar: 'QWEN_TOKEN_PLAN_CN_API_KEY', authKey: 'qwen-token-plan-cn' },
  { id: 'xai-api', name: 'xAI（API key）', kind: 'api_key', hint: '与上面的订阅是两条路', envVar: 'XAI_API_KEY', authKey: 'xai' },
  { id: 'groq', name: 'Groq', kind: 'api_key', hint: '', envVar: 'GROQ_API_KEY', authKey: 'groq' },
  { id: 'mistral', name: 'Mistral', kind: 'api_key', hint: '', envVar: 'MISTRAL_API_KEY', authKey: 'mistral' },
  { id: 'together', name: 'Together AI', kind: 'api_key', hint: '', envVar: 'TOGETHER_API_KEY', authKey: 'together' },
  { id: 'fireworks', name: 'Fireworks', kind: 'api_key', hint: '', envVar: 'FIREWORKS_API_KEY', authKey: 'fireworks' },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'api_key', hint: '', envVar: 'NVIDIA_API_KEY', authKey: 'nvidia' },
  { id: 'openrouter-key', name: 'OpenRouter（API key）', kind: 'api_key', hint: '', envVar: 'OPENROUTER_API_KEY', authKey: 'openrouter' }
]

/* ------------------------------------------------------------------ 读写 */

async function readAuth(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(AUTH_FILE, 'utf8')
    const j = JSON.parse(raw) as unknown
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 写入一个 provider 的凭证。
 *
 * **合并**写入：只动这一个 key，其它 provider 的条目原样保留 ——
 * 否则用户配第二个 provider 时会把第一个弄丢。
 * 文件权限尽量设 0600（与 pi 一致；Windows 上这个位不生效，但不报错）。
 */
export async function setApiKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }> {
  const id = provider.trim()
  const val = key.trim()
  if (!id) return { ok: false, error: 'provider 不能为空' }
  if (!val) return { ok: false, error: 'API key 不能为空' }

  try {
    await mkdir(PI_DIR, { recursive: true })
    const cur = await readAuth()
    cur[id] = { type: 'api_key', key: val }
    await writeFile(AUTH_FILE, JSON.stringify(cur, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
  }
}

/** 移除一个 provider 的凭证（界面上就是「退出登录」） */
export async function clearAuth(provider: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const cur = await readAuth()
    if (!(provider in cur)) return { ok: true }
    delete cur[provider]
    await writeFile(AUTH_FILE, JSON.stringify(cur, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}

/* ------------------------------------------------------------ 状态查询 */

/**
 * 问 pi 这个 provider 能不能用。
 *
 * 用 `pi auth check --provider X --json` —— 它比我们自己判断可靠：
 * 它会**刷新过期的 OAuth token**（这正是订阅制最需要的），
 * 也会认 provider 的平台差异（比如部分 provider 只看环境变量）。
 *
 * 失败一律降级为「未知」，绝不因此让界面报错 —— 状态查询是辅助信息。
 */
function checkViaPi(
  piCmd: string,
  piArgs: string[],
  provider: string
): Promise<{ status: AuthStatus; detail?: string }> {
  return new Promise((resolve) => {
    execFile(
      piCmd,
      [...piArgs, 'auth', 'check', '--provider', provider, '--json'],
      { timeout: 20_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ status: 'unknown', detail: '无法查询（pi 未找到或未安装）' })
          return
        }
        try {
          const j = JSON.parse(String(stdout).trim()) as { status?: string; reason?: string; authType?: string }
          resolve({
            status: j.status === 'ready' ? 'ready' : 'missing',
            detail: j.reason === 'credentials_not_configured' ? '未配置凭证' : j.reason
          })
        } catch {
          resolve({ status: 'unknown' })
        }
      }
    )
  })
}

/**
 * 列出所有接入方式 + 各自状态。
 *
 * ⚠️ 逐个 `pi auth check` 会**起 N 个 pi 进程**（实测 19 项 ≈ 1.1s）。
 * 所以默认只对比 auth.json（0ms）；查 pi 是可选的（`deep: true`），
 * 界面用「重新检测」按钮触发。
 *
 * ⚠️ 重要：也要把**已配置但不在目录里**的 provider 列出来。
 * 本会话踩过：用户已有 `commandcode` 凭证、对话完全正常，
 * 但界面显示「0/N 已就绪」——因为那个 provider 不在我的小目录里。
 * 那会让人以为「什么都没配上」而去乱改配置。
 */
export async function listAuthProviders(
  pi: { cmd: string; args: string[] },
  deep = false
): Promise<AuthProviderInfo[]> {
  const auth = await readAuth()
  const configured = new Set<string>()
  for (const [k, v] of Object.entries(auth)) {
    const o = v as { type?: string; key?: string } | null
    if (o && (o.key || o.type === 'oauth')) configured.add(k)
  }

  /*
   * 环境变量里的 key 也算已配置。
   *
   * ⚠️ 这里原本**完全没看 envVar** —— CATALOG 里每一项都写了 envVar，
   * 但那列声明一直没人用。后果：用 `ANTHROPIC_API_KEY` 之类环境变量配好的
   * 用户，界面上显示「还没配置」，引导页第 2 步也会卡住（用户报过）。
   *
   * 只有**非空**才算；空字符串/纯空白视为没设（Windows 上很容易
   * 留下 `set X=` 这种空值）。
   */
  const fromEnv = (name: string): boolean => {
    if (!name) return false
    const v = process.env[name]
    return typeof v === 'string' && v.trim().length > 0
  }

  const base: AuthProviderInfo[] = CATALOG.map((c) => {
    if ((c.authKey && configured.has(c.authKey)) || configured.has(c.id)) {
      return { ...c, status: 'ready' as const, source: 'auth.json' as const }
    }
    if (fromEnv(c.envVar)) {
      return { ...c, status: 'ready' as const, source: 'env' as const }
    }
    return { ...c, status: 'missing' as const }
  })

  /*
   * 把已配置但不在目录里的补上。
   *
   * 为什么值得做：pi 支持 35+ 个 provider，我们只列常见的十几个。
   * 用户如果用了别的（或自定义的），至少要让他在界面上看到
   * 「这个已经配好了」，而不是一脸茫然。
   */
  const known = new Set<string>()
  for (const c of CATALOG) {
    if (c.authKey) known.add(c.authKey)
    known.add(c.id)
  }
  for (const id of configured) {
    if (known.has(id)) continue
    base.push({
      id,
      name: id,
      kind: 'api_key',
      hint: '',
      envVar: '',
      authKey: id,
      status: 'ready',
      source: 'auth.json'
    })
  }

  if (!deep) return base

  // deep：对每一项问 pi（比较慢，界面上要有 loading）
  return Promise.all(
    base.map(async (c) => {
      /*
       * 探测用的名字：
       *   · 目录里的自定义项 → 直接用 id（它就是 auth.json 的键）
       *   · 订阅制 → 去掉我给的人为后缀（`openai-codex` → `openai`）
       *   · API key → 用 authKey
       */
      const probeId =
        c.hint === '' && c.name === c.id
          ? c.id
          : c.kind === 'subscription'
            ? c.id.replace(/-codex$/, '')
            : c.authKey || c.id
      const r = await checkViaPi(pi.cmd, pi.args, probeId)
      // pi 说 ready / 说缺 → 以 pi 为准（它会考虑环境变量）
      if (r.status === 'ready') return { ...c, status: 'ready' as const }
      if (r.status === 'missing') return { ...c, status: 'missing' as const }
      return c
    })
  )
}

/** auth.json 是否存在、有多少条（界面上用来提示「凭证放在哪」） */
export async function authFileInfo(): Promise<{ path: string; exists: boolean; count: number }> {
  try {
    await stat(AUTH_FILE)
    const j = await readAuth()
    return { path: AUTH_FILE, exists: true, count: Object.keys(j).length }
  } catch {
    return { path: AUTH_FILE, exists: false, count: 0 }
  }
}

/* `@` 文件引用补全 */

/**
 * 列出与 `prefix` 匹配的路径（**只读一层目录**）。
 *
 * ⚠️ 为什么不递归扫整个项目：
 *   仓库里动较几万个文件，扫一遍慢、占内存、还会碰到权限问题。
 *   而补全只需要「用户已打出的这段前缀接下来可能是什么」——
 *   那是**一层 readdir** 的事。
 *
 * `@src/ma` → 读 <cwd>/src/，返回以 `ma` 开头的条目。
 *
 * 安全：只允许在 `cwd` 内读，且跳过 node_modules / .git ——
 *   （它们是噪声，而且巨大）。
 */
export async function completePath(cwd: string, prefix: string): Promise<string[]> {
  const raw = prefix.replace(/\\/g, '/')
  const slash = raw.lastIndexOf('/')
  const dirPart = slash >= 0 ? raw.slice(0, slash) : ''
  const namePart = (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase()

  // 拒绝跳出 cwd 的路径（`..`、绝对路径）
  if (dirPart.includes('..') || /^[A-Za-z]:/.test(dirPart) || dirPart.startsWith('/')) return []

  const base = join(cwd, dirPart)
  try {
    const entries = await readdir(base, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      if (e.name.startsWith('.')) continue // 隐藏文件（大多是噪声）
      if (namePart && !e.name.toLowerCase().startsWith(namePart)) continue
      const rel = (dirPart ? dirPart + '/' : '') + e.name + (e.isDirectory() ? '/' : '')
      out.push(rel)
      if (out.length >= 30) break
    }
    // 目录优先（用户更可能是要进目录）
    return out.sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')))
  } catch {
    return []
  }
}
