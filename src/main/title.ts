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
import { YAN_DIR } from './paths'

const TITLES_FILE = join(YAN_DIR, 'titles.json')

/** sessionId → 标题 */
type TitleMap = Record<string, string>

/**
 * 用户**手动**重命名的会话名（sessionId → 名字）。
 *
 * 为什么要与 titles.json 分开：自动生成的标题每轮都会重算（用户要求
 * 「每次对话标题需要 agent 生成一个新的」），如果把手动名写进同一张表，
 * 下一轮就会被自动标题覆盖 —— 用户报的「重命名不管用」有一半是这个原因。
 * 分开存之后，手动名是**粘性**的：有手动名就不再自动生成。
 */
const MANUAL_FILE = join(YAN_DIR, 'manual-titles.json')

async function loadMap(file: string): Promise<TitleMap> {
  try {
    const raw = await readFile(file, 'utf8')
    const j = JSON.parse(raw) as TitleMap
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

async function loadTitles(): Promise<TitleMap> {
  return loadMap(TITLES_FILE)
}

/** 加载手动重命名的会话名（渲染端启动时一次性拉走） */
export async function manualTitles(): Promise<TitleMap> {
  return loadMap(MANUAL_FILE)
}

/** 某个会话是否有手动名（有则不再自动生成标题） */
export async function manualTitleOf(sessionId: string): Promise<string | undefined> {
  const all = await loadMap(MANUAL_FILE)
  return all[sessionId]
}

/** 写一个手动会话名（空串 = 清除，恢复自动标题） */
export async function setManualTitle(sessionId: string, name: string): Promise<void> {
  try {
    const all = await loadMap(MANUAL_FILE)
    const trimmed = name.trim()
    if (trimmed) all[sessionId] = trimmed.slice(0, 60)
    else delete all[sessionId]
    await mkdir(YAN_DIR, { recursive: true })
    await writeFile(MANUAL_FILE, JSON.stringify(all, null, 2), 'utf8')
  } catch {
    /* 存不下就算了 */
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
function buildPrompt(samples: string[]): string {
  const body = samples
    .map((s, i) => `${i === 0 ? '开头' : i === samples.length - 1 ? '现在' : `第 ${i + 1} 句`}：${s}`)
    .join('\n')

  return [
    '下面是一段对话的节选。给这段对话起一个标题。',
    '要求：',
    '1. 不超过 18 个汉字（硬限制，超了就重想一个更短的）',
    '2. 只输出标题本身 —— 不要引号、句号、冒号，不要解释',
    '3. 具体优于抽象：“重构标题生成” 比 “代码相关讨论” 好',
    '4. 用中文（除非下面是纯英文对话）',
    '',
    body,
    '',
    '标题：'
  ].join('\n')
}

/**
 * 标题长度上限（汉字个数）。
 *
 * ⚠️ 原来是 8 —— 用户报「会话标题显示字很少」：8 个字写不出信息量
 *（“查看图片”“网线治丢包”），左栏里一排都长得很像。
 * 放到 18：能写下一个动词 + 一个对象，且不会撑破左栏。
 */
const TITLE_MAX = 18

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
  // 上限（见 TITLE_MAX 的说明）。宁可我截，也不要一个撑破左栏的标题。
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX)
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
 *
 * `samples` 是要总结的几个片段（按时间顺序）：一般传
 * [第一句用户话, 最近一句用户话]，这样标题跟得上话题的移动。
 *
 * `force` 为 true 时**不用缓存**，重新生成：
 *   用户要求「每次对话标题需要 agent 生成一个新的」，所以每轮都会重算。
 *   缓存仍然写（给左栏与切会话时先用一个已有的值垫着）。
 */
export async function generateTitle(opts: {
  sessionId: string
  samples: string[]
  cwd: string
  piBin?: string
  /**
   * 随首条消息附带的图片。用户报「首条消息带图时标题生成不了」——
   * 只把文字交给归纳进程，纯图片的消息摘要不出任何东西。
   * 把图片也传过去，模型能看着图起标题。
   */
  images?: { data: string; mimeType: string }[]
  timeoutMs?: number
  force?: boolean
}): Promise<TitleResult | null> {
  const { sessionId, cwd, piBin } = opts
  const timeout = opts.timeoutMs ?? 60_000

  const samples = opts.samples.map((s) => s.trim()).filter(Boolean)
  if (samples.length === 0) return null

  // 手动重命名是**粘性**的：有手动名就不再自动生成（否则每轮又会盖掉）
  const manual = await manualTitleOf(sessionId)
  if (manual) return { title: manual, fromCache: true }

  // 已经有缓存且不要求重算 → 直接用
  if (!opts.force) {
    const cached = await loadTitles()
    if (cached[sessionId]) return { title: cached[sessionId], fromCache: true }
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
        await rpc.command('prompt', {
          message: buildPrompt(samples),
          // pi 的 prompt 支持 images（见 rpc-types.d.ts 的 prompt 命令）
          ...(opts.images?.length
            ? { images: opts.images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) }
            : {})
        })
      } catch (e) {
        clearTimeout(timer)
        console.error('[title] 发送失败:', e)
        done(null)
      }
    })()
  })
}
