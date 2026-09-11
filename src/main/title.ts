/**
 * 会话标题生成。
 *
 * 用**独立的 pi 进程**跑一次极短的请求，把用户的第一句话总结成几个字。
 * 为什么不复用主会话：
 *   ① 会污染对话 —— 用户会看到「总结这句话」这种莫名其妙的消息
 *   ② 会改变上下文 —— 前缀一变，prompt cache 全失效（这个代价比一次请求贵得多）
 *   ③ 归纳任务不该出现在对话历史里
 *
 * 所以在 `--no-session --no-extensions` 下起一个用完即走的进程，
 * thinking 关掉（归纳不需要推理，省钱也快）。
 *
 * 缓存：同一会话只生成一次，结果落在 ~/.pi/agent/yan/titles.json。
 * 失败一律静默降级 —— 标题生成失败不该影响任何事。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PiRpc } from './protocol'
import { YAN_DIR } from './memory'

const TITLES_FILE = join(YAN_DIR, 'titles.json')

/** sessionId → 标题 */
type TitleMap = Record<string, string>

async function loadTitles(): Promise<TitleMap> {
  try {
    const raw = await readFile(TITLES_FILE, 'utf8')
    const j = JSON.parse(raw) as TitleMap
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

async function saveTitle(sessionId: string, title: string): Promise<void> {
  try {
    const all = await loadTitles()
    all[sessionId] = title
    // 只留最近 300 条，别让它无限涨
    const keys = Object.keys(all)
    if (keys.length > 300) {
      for (const k of keys.slice(0, keys.length - 300)) delete all[k]
    }
    await mkdir(YAN_DIR, { recursive: true })
    await writeFile(TITLES_FILE, JSON.stringify(all, null, 2), 'utf8')
  } catch {
    /* 存不下就算了，标题本来是可再生的 */
  }
}

/** 已缓存的标题（渲染端启动时一次性拉走，避免重复生成） */
export async function cachedTitles(): Promise<TitleMap> {
  return loadTitles()
}

/* ==================================================================
   生成
   ================================================================== */

/** 提示词：要短、要具体、不要标点。写死英文指令 + 中文示例，模型更稳 */
function buildPrompt(first: string): string {
  return [
    '给下面这句用户的话起一个标题。',
    '要求：不超过 10 个汉字；只输出标题本身；不要引号、句号、冒号；不要解释。',
    '如果原句很短（少于 10 个字），直接原样输出即可。',
    '',
    first.slice(0, 400)
  ].join('\n')
}

/** 清洗模型输出 —— 它经常不听话地加引号或句号 */
function cleanTitle(raw: string): string {
  let s = raw.trim()
  // 去掉包裹的引号 / 书名号 / 括号
  s = s.replace(/^["'“”『「【\[(（]+/, '').replace(/["'“”』」】\])）]+$/, '')
  // 去掉结尾标点
  s = s.replace(/[。！？!?.,，、；;：:]+$/, '')
  // 去掉「标题：」这种前缀
  s = s.replace(/^(标题|title)\s*[:：]\s*/i, '')
  // 只取第一行（模型有时会多写一行解释）
  s = s.split('\n')[0].trim()
  // 上限 24 个字符，超了截断（宁可我截，也不要一个字库长度的标题）
  if (s.length > 24) s = s.slice(0, 24)
  return s
}

export interface TitleResult {
  title: string
  fromCache?: boolean
}

/**
 * 生成标题。失败返回 null（调用方静默忽略）。
 *
 * `cwd` 用用户自己的目录 —— pi 启动时会读 AGENTS.md 之类，
 * 换个目录可能行为不一致。
 */
export async function generateTitle(opts: {
  sessionId: string
  firstMessage: string
  cwd: string
  piBin?: string
  timeoutMs?: number
}): Promise<TitleResult | null> {
  const { sessionId, firstMessage, cwd, piBin } = opts
  const timeout = opts.timeoutMs ?? 60_000

  const first = firstMessage.trim()
  if (!first) return null

  // 已经有缓存就不再请求
  const cached = await loadTitles()
  if (cached[sessionId]) return { title: cached[sessionId], fromCache: true }

  // 太短的句子不需要归纳，直接用（省一次请求）
  if (first.length <= 10) {
    const t = cleanTitle(first)
    await saveTitle(sessionId, t)
    return { title: t }
  }

  const rpc = new PiRpc({
    cwd,
    piBin,
    args: ['--no-session', '--no-extensions']
  })

  let text = ''
  let settled = false

  return new Promise<TitleResult | null>((resolve) => {
    const done = (r: TitleResult | null): void => {
      if (settled) return
      settled = true
      void rpc.close()
      resolve(r)
    }

    const timer = setTimeout(() => {
      console.error('[title] 超时')
      done(null)
    }, timeout)

    rpc.on('event', (evt) => {
      const type = String(evt.type ?? '')
      if (type === 'message_update') {
        const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
        if (ev?.type === 'text_delta') text += String(ev.delta ?? '')
      } else if (type === 'agent_settled' || type === 'agent_end') {
        // agent_settled 更权威（agent_end 之后可能还有重试）
        if (type !== 'agent_settled') return
        clearTimeout(timer)
        const title = cleanTitle(text)
        if (!title) {
          done(null)
          return
        }
        void saveTitle(sessionId, title)
        done({ title })
      }
    })

    rpc.on('exit', (code) => {
      clearTimeout(timer)
      // 进程提前退出也算失败
      if (!settled && code !== 0) done(null)
    })

    rpc.on('stderr', (line) => {
      // 只记不处理 —— 标题失败不该打扰用户
      console.error('[title] stderr:', line)
    })

    rpc.spawn()

    // 起来之后再发指令
    void (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        try {
          const st = await rpc.command('get_state')
          if (st.success) break
        } catch {
          /* 还没起来 */
        }
      }
      try {
        // 归纳不需要推理 —— 关掉省钱也快
        await rpc.command('set_thinking_level', { level: 'off' })
        await rpc.command('prompt', { message: buildPrompt(first) })
      } catch (e) {
        clearTimeout(timer)
        console.error('[title] 发送失败:', e)
        done(null)
      }
    })()
  })
}
