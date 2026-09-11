/**
 * 砚 · 记忆扩展
 *
 * 由桌面端用 `pi --extension <此文件>` 显式加载 —— **不写进用户的
 * ~/.pi/agent/extensions/**，所以不干扰用户已有的扩展，也不需要安装步骤。
 *
 * 它做三件事：
 *   1. 给 agent 一个 `remember` 工具 —— 但**只能记成「未确认」**
 *   2. 给 agent `recall` / `forget`，让它能查和忘
 *   3. 每次对话开始前，把记忆注入系统提示词：
 *        已确认的 → 直接陈述
 *        未确认的 → 强制带「我不确定」的语气
 *
 * 第 3 点是整个产品的着力点：认识论上的区分必须**改变模型的行为**，
 * 否则右栏那个「对/不对」按钮就只是个装饰。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ==================================================================
   存储（与桌面端主进程共享同一个文件）
   ================================================================== */

// YAN_DATA_DIR 与主进程的约定一致：测试跑隔离目录时两边都不会碰真实记忆。
const DIR = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
const FILE = join(DIR, 'memory.json')

interface MemoryItem {
  id: string
  kind: 'fact' | 'guess'
  text: string
  source: 'you' | 'me'
  topic: string
  createdAt: number
  updatedAt: number
  confirmedAt?: number
  sessionId?: string
}

function load(): MemoryItem[] {
  try {
    const raw = readFileSync(FILE, 'utf8')
    const parsed = JSON.parse(raw) as { items?: MemoryItem[] }
    return Array.isArray(parsed.items) ? parsed.items : []
  } catch {
    return []
  }
}

/** 原子写，避免桌面端读到半个文件 */
function save(items: MemoryItem[]): void {
  try {
    mkdirSync(DIR, { recursive: true })
    const tmp = `${FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
    renameSync(tmp, FILE)
  } catch {
    /* 存不下就放弃，不要打断对话 */
  }
}

function newId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ==================================================================
   扩展
   ================================================================== */

export default function (pi: ExtensionAPI) {
  /* ----------------------------------------------------------------
     工具：remember
     ⚠️ 只能写 kind='guess'。
        agent 不能自己批准自己的判断 —— 只有用户在界面上点「对」才升级为 fact。
        这不是技术限制，是产品不变量。改它之前请先改文档。
     ---------------------------------------------------------------- */
  pi.registerTool({
    name: 'remember',
    label: '记住',
    description:
      '记下一条关于用户的信息，供以后参考。注意：记下的内容默认处于「未确认」状态，' +
      '只有用户在应用里确认后才会被当作事实使用。所以不要把它当作已验证的知识。',
    promptSnippet: '记住一条关于用户的信息（默认未确认）',
    promptGuidelines: [
      'Use remember when you learn something durable about the user — a preference, a person, a project, a constraint. Do not use it for transient details of the current task.',
      'Text passed to remember is unconfirmed until the user approves it in the app. Never state it back to the user as established fact in the same session.',
    ],
    parameters: Type.Object({
      text: Type.String({ description: '要记住的内容，用一句陈述句，不要写「用户说」' }),
      topic: Type.Optional(
        Type.String({ description: '分类：about（关于用户，默认）/ people（人）/ projects（项目）' })
      )
    }),

    async execute(_id, params) {
      const text = String(params.text ?? '').trim()
      if (!text) {
        return { content: [{ type: 'text', text: '没给内容，没记。' }] }
      }

      const items = load()
      const topic = String(params.topic ?? 'about')

      if (items.some((m) => m.text === text && m.topic === topic)) {
        return { content: [{ type: 'text', text: `已经记过了：「${text}」` }] }
      }

      const now = Date.now()
      const item: MemoryItem = {
        id: newId(),
        kind: 'guess', // ← 只能是 guess，见上方说明
        source: 'me',
        text,
        topic,
        createdAt: now,
        updatedAt: now
      }
      items.push(item)
      save(items)

      return {
        content: [
          {
            type: 'text',
            text: `记下了（未确认）：「${text}」 id=${item.id}\n用户可以确认或否认它。`
          }
        ],
        details: item
      }
    }
  })

  /* ----------------------------------------------------------------
     工具：recall —— 查记忆
     ---------------------------------------------------------------- */
  pi.registerTool({
    name: 'recall',
    label: '回忆',
    description: '查询已记住的关于用户的信息。返回时会标明哪些是已确认的、哪些是未确认的。',
    promptSnippet: '查询已记住的关于用户的信息',
    promptGuidelines: [
      'Use recall when the user refers to something you might have been told before, or before asking the user to repeat themselves.',
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '关键词，留空则返回全部' })),
      topic: Type.Optional(Type.String({ description: '限定分类：about / people / projects' }))
    }),

    async execute(_id, params) {
      const q = String(params.query ?? '').trim().toLowerCase()
      const topic = params.topic ? String(params.topic) : undefined

      let items = load()
      if (topic) items = items.filter((m) => m.topic === topic)
      if (q) items = items.filter((m) => m.text.toLowerCase().includes(q))

      if (items.length === 0) {
        return { content: [{ type: 'text', text: '没有相关记忆。' }] }
      }

      const facts = items.filter((m) => m.kind === 'fact')
      const guesses = items.filter((m) => m.kind === 'guess')

      const lines: string[] = []
      if (facts.length) {
        lines.push('【已确认，可直接使用】')
        for (const m of facts) lines.push(`  ${m.text}  [id=${m.id}, ${m.topic}]`)
      }
      if (guesses.length) {
        lines.push('【未确认，使用时必须说明你不确定】')
        for (const m of guesses) lines.push(`  ${m.text}  [id=${m.id}, ${m.topic}]`)
      }

      return { content: [{ type: 'text', text: lines.join('\n') }], details: { items } }
    }
  })

  /* ----------------------------------------------------------------
     工具：forget —— 忘掉一条
     只能删未确认的。已确认的记忆要用户自己撤，agent 不能替用户改事实。
     ---------------------------------------------------------------- */
  pi.registerTool({
    name: 'forget',
    label: '忘掉',
    description:
      '删除一条未确认的记忆。已确认的记忆不能由此删除 —— 那需要用户自己在应用里撤回。',
    promptSnippet: '删除一条未确认的记忆',
    promptGuidelines: [
      'Use forget when the user says a remembered impression is wrong, and you have the memory id from recall.',
    ],
    parameters: Type.Object({
      id: Type.String({ description: '记忆的 id，从 recall 的结果里拿' })
    }),

    async execute(_id, params) {
      const id = String(params.id ?? '')
      const items = load()
      const target = items.find((m) => m.id === id)

      if (!target) {
        return { content: [{ type: 'text', text: `没找到 id=${id} 的记忆。` }] }
      }
      if (target.kind === 'fact') {
        return {
          content: [
            {
              type: 'text',
              text: `「${target.text}」是用户已确认的记忆，我不能删。请让用户在右侧面板撤回。`
            }
          ]
        }
      }

      save(items.filter((m) => m.id !== id))
      return { content: [{ type: 'text', text: `忘了：「${target.text}」` }] }
    }
  })

  /* ----------------------------------------------------------------
     注入系统提示词 —— 认识论差异在这里变成行为差异
     ---------------------------------------------------------------- */
  pi.on('before_agent_start', async (event) => {
    const items = load()
    if (items.length === 0) return

    const facts = items.filter((m) => m.kind === 'fact')
    const guesses = items.filter((m) => m.kind === 'guess')

    const parts: string[] = []

    if (facts.length) {
      parts.push(
        '## 关于用户（已确认）\n' +
          '以下是用户确认过的事实，可以直接使用：\n' +
          facts.map((m) => `- ${m.text}`).join('\n')
      )
    }

    if (guesses.length) {
      parts.push(
        '## 关于用户（我的印象，未确认）\n' +
          '以下是你自己观察到的，**用户从未确认过**。它们可能是错的：\n' +
          guesses.map((m) => `- ${m.text}`).join('\n') +
          '\n\n使用这些印象时必须让不确定感可见：说「我记得你好像…」「如果我没记错」这类措辞，' +
          '不要把它们当作既定事实陈述，也不要据此替用户做决定。' +
          '如果某条印象影响了你的建议，顺便提一句它的来源是你自己的观察。'
      )
    }

    if (parts.length === 0) return

    return {
      systemPrompt:
        event.systemPrompt +
        '\n\n---\n\n' +
        parts.join('\n\n') +
        '\n\n（这段记忆由「砚」的 remember/recall 工具维护。要补记就用 remember，要查就用 recall。）'
    }
  })
}
