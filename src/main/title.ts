import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PiRpc } from './protocol'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { toUsage } from './normalize'
import { appendContextBackgroundUsage } from './context-background-usage'

const TITLES_FILE = join(YAN_DIR, 'titles.json')

type TitleMap = Record<string, string>

const MANUAL_FILE = join(YAN_DIR, 'manual-titles.json')

async function loadMap(file: string): Promise<TitleMap> {
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('标题文件结构无效')
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key && typeof value === 'string'))
}

async function writeMapAtomic(file: string, value: TitleMap): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function loadTitles(): Promise<TitleMap> {
  return loadMap(TITLES_FILE)
}

export async function manualTitles(): Promise<TitleMap> {
  return loadMap(MANUAL_FILE)
}

export async function manualTitleOf(sessionId: string): Promise<string | undefined> {
  const all = await loadMap(MANUAL_FILE)
  return all[sessionId]
}

export async function setManualTitle(
  sessionId: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const all = await loadMap(MANUAL_FILE)
    const trimmed = name.trim()
    if (trimmed) all[sessionId] = Array.from(trimmed).slice(0, 60).join('')
    else delete all[sessionId]
    await writeMapAtomic(MANUAL_FILE, all)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function saveTitle(sessionId: string, title: string): Promise<void> {
  try {
    const all = await loadTitles()
    all[sessionId] = title
    const keys = Object.keys(all)
    if (keys.length > 300) {
      for (const k of keys.slice(0, keys.length - 300)) delete all[k]
    }
    await writeMapAtomic(TITLES_FILE, all)
  } catch {
  }
}

export async function cachedTitles(): Promise<TitleMap> {
  return loadTitles()
}

function buildPrompt(samples: string[]): string {
  const body = samples
    .map((s, i) => `${i === 0 ? '开头' : i === samples.length - 1 ? '现在' : `第 ${i + 1} 句`}：${s}`)
    .join('\n')

  return [
    '下面是一段对话的节选。给这段对话起一个标题。',
    '要求：',
    '1. 中文建议不超过 9 个汉字宽度，英文建议不超过 18 个 ASCII 字符；优先简短名词短语',
    '2. 只输出标题本身 —— 不要引号、句号、冒号，不要解释',
    '3. 具体优于抽象：“重构标题生成” 比 “代码相关讨论” 好',
    '4. 用中文（除非下面是纯英文对话）',
    '',
    body,
    '',
    '标题：'
  ].join('\n')
}

const TITLE_MAX = 18

function cleanTitle(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^["'“”『「【\[(（]+/, '').replace(/["'“”』」】\])）]+$/, '')
  s = s.replace(/[。！？!?.,，、；;：:]+$/, '')
  s = s.replace(/^(标题|title)\s*[:：]\s*/i, '')
  s = s.split('\n')[0].trim()
  if (Array.from(s).length > TITLE_MAX) s = Array.from(s).slice(0, TITLE_MAX).join('')
  return s
}

export interface TitleResult {
  title: string
  fromCache?: boolean
}

export async function generateTitle(opts: {
  sessionId: string
  samples: string[]
  cwd: string
  piBin?: string
  images?: { data: string; mimeType: string }[]
  timeoutMs?: number
  force?: boolean
  allowManual?: boolean
  persist?: boolean
}): Promise<TitleResult | null> {
  const { sessionId, cwd, piBin } = opts
  const timeout = opts.timeoutMs ?? 60_000

  const samples = opts.samples.map((s) => s.trim()).filter(Boolean)
  if (samples.length === 0) return null

  const manual = await manualTitleOf(sessionId)
  if (manual && !opts.allowManual) return { title: manual, fromCache: true }

  if (!opts.force) {
    const cached = await loadTitles()
    if (cached[sessionId]) return { title: cached[sessionId], fromCache: true }
  }

  const rpc = new PiRpc({
    cwd,
    piBin,
    args: [
      '--no-session',
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      ...(process.env.YAN_TEST_MODEL ? ['--model', process.env.YAN_TEST_MODEL] : [])
    ],
    env: { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR }
  })

  let text = ''
  let settled = false
  let usage: ReturnType<typeof toUsage> = undefined
  let startedAt = 0

  return new Promise<TitleResult | null>((resolve) => {
    const done = (r: TitleResult | null, errorCode?: string): void => {
      if (settled) return
      settled = true
      appendContextBackgroundUsage(sessionId, {
        kind: 'title',
        ok: !!r?.title,
        usage: r?.title ? usage ?? null : null,
        ...(startedAt > 0 ? { durationMs: Date.now() - startedAt } : {}),
        ...(r?.title ? {} : { error: errorCode ?? 'title_unavailable' })
      })
      void rpc.close()
      resolve(r)
    }

    const timer = setTimeout(() => {
      console.error('[title] 超时')
      done(null, 'title_timeout')
    }, timeout)

    rpc.on('event', (evt) => {
      const type = String(evt.type ?? '')
      if (type === 'message_update') {
        const ev = evt.assistantMessageEvent as Record<string, unknown> | undefined
        if (ev?.type === 'text_delta') text += String(ev.delta ?? '')
      } else if (type === 'message_end') {
        const message = (evt as Record<string, unknown>).message as Record<string, unknown> | undefined
        const parsed = toUsage(message?.usage as Parameters<typeof toUsage>[0])
        if (parsed) usage = parsed
      } else if (type === 'agent_settled' || type === 'agent_end') {
        if (type !== 'agent_settled') return
        clearTimeout(timer)
        const title = cleanTitle(text)
        if (!title) {
          done(null, 'title_empty')
          return
        }
        if (opts.persist !== false) void saveTitle(sessionId, title)
        done({ title })
      }
    })

    rpc.on('exit', () => {
      clearTimeout(timer)
      if (!settled) done(null, 'title_process_exit')
    })

    rpc.on('stderr', (line) => {
      console.error('[title] stderr:', line)
    })

    rpc.spawn()

    void (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        try {
          const st = await rpc.command('get_state')
          if (st.success) break
        } catch {
        }
      }
      try {
        await rpc.command('set_thinking_level', { level: 'off' })
        startedAt = Date.now()
        await rpc.command('prompt', {
          message: buildPrompt(samples),
          ...(opts.images?.length
            ? { images: opts.images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) }
            : {})
        })
      } catch (e) {
        clearTimeout(timer)
        console.error('[title] 发送失败:', e)
        done(null, 'title_prompt_failed')
      }
    })()
  })
}
