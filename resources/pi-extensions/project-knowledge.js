/*
 * 砚内置「项目知识注入」薄层扩展（实施-03 S3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这里只有「读文件 + 放消息」两件事
 * ══════════════════════════════════════════════════════════════════
 * 检索、打分、预算、状态过滤（只注入 active）**全部在宿主**
 * （`src/main/project-knowledge.ts` + `src/shared/project-memory-search.ts`）。
 * 这里留着的唯一理由是「请求发出前把一段材料放进上下文」这件事没有任何
 * CLI / RPC 等价物（属于允许钩子白名单里的 `before_provider_request`）。
 * 任何算法都不该长在这份文件里 —— 它一长，就又是「薄层长回插件」。
 *
 * 交接方式是**一个每会话一档的文件**：宿主在用户消息交给 pi 之前写好
 * `YAN_DIR/project-knowledge/_inject/<会话键>.json`，这里读它。
 * 关闭开关时宿主也会写（`enabled:false`、空 block）—— 所以「关闭立即失效」
 * 不需要扩展自己记状态：下一轮读到空块自然就不注入。
 *
 * 位置与 `language.js` 同一条实测结论：放在最后一条用户消息**前面**的独立
 * 消息里（而不是系统提示末尾）—— 后者在长提示里实测不被模型当回事。
 * 材料块自己写明「参考材料、不是授权、不是当前指令」，这里不再加任何指令性措辞。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

/** 会话键 → 文件名。必须与宿主 `knowledgeInjectFileName` 的规则一致。 */
function safeSessionKey(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return safe || 'session'
}

function injectionFile() {
  const sessionId = process.env.YAN_SESSION_ID?.trim()
  if (!sessionId) return null
  return join(dataDir(), 'project-knowledge', '_inject', `${safeSessionKey(sessionId)}.json`)
}

/**
 * 读宿主准备好的注入记录。
 *
 * 任何一种异常（文件不在 / 半个 JSON / 字段不对）都按「这一轮不注入」处理：
 * 注入失败不该让对话失败，但**不能**猜内容。
 */
function readInjection() {
  const file = injectionFile()
  if (!file) return { file: null, record: null }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record?.enabled !== true) return { file, record: null }
    if (typeof record.block !== 'string' || !record.block.trim()) return { file, record: null }
    return { file, record }
  } catch {
    return { file, record: null }
  }
}

/** 诊断钩子：`YAN_KNOWLEDGE_EXT_LOG` 指向文件时每次注入写一行 JSON（live 取证用）。 */
function trace(hook, extra) {
  const file = process.env.YAN_KNOWLEDGE_EXT_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ ts: Date.now(), hook, ...extra }) + '\n')
  } catch {
    /* 写不进去不影响注入本身 */
  }
}

export default function projectKnowledgeExtension(pi) {
  pi.on('before_provider_request', (event) => {
    const payload = event?.payload
    const messages = payload?.messages
    if (!payload || !Array.isArray(messages) || messages.length === 0) return

    const { file, record } = readInjection()
    trace('payload', {
      file,
      injected: !!record,
      reason: record ? 'ok' : 'empty',
      ids: record?.hits?.map((hit) => hit.id) ?? []
    })
    if (!record) return

    /* 已经在本轮消息里（例如 provider 重试同一次请求）→ 不重复插 */
    if (messages.some((message) => typeof message?.content === 'string' && message.content.includes(record.block))) {
      trace('skip', { reason: 'already-present' })
      return
    }

    let at = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        at = i
        break
      }
    }
    if (at < 0) return
    /* 角色跟着这个 provider 已经在用的写法（与 language.js 同一条） */
    const already = messages.find((m) => m?.role === 'system' || m?.role === 'developer')?.role
    const role = already === 'system' || already === 'developer' ? already : 'system'
    const next = [...messages.slice(0, at), { role, content: record.block }, ...messages.slice(at)]
    trace('inject', { at, role, ids: record.hits.map((hit) => hit.id), tokens: record.tokens })
    return { ...payload, messages: next }
  })
}
