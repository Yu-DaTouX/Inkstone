import type { NativeSessionHostRequest } from '../shared/native-session-host'
import type { SessionState } from '../shared/ipc'
import { pick } from '../shared/ui-lang'

const ACTIONS = new Set([
  'tree', 'entries', 'navigate', 'set-label', 'reload', 'scoped-models', 'set-scoped-models',
  'trust', 'set-trust', 'import', 'export-jsonl', 'share', 'new-session'
])
const MUTATIONS = new Set(['navigate', 'set-label', 'reload', 'set-scoped-models', 'set-trust', 'import', 'new-session', 'share', 'export-jsonl'])

export function validateNativeSessionRequest(
  input: unknown,
  state: SessionState | null,
  extraBusy = false
): { ok: true; request: NativeSessionHostRequest } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: pick('原生会话请求无效', 'Invalid native session request') }
  const req = input as Record<string, unknown>
  if (typeof req.action !== 'string' || !ACTIONS.has(req.action)) return { ok: false, error: pick('不支持的原生会话操作', 'Unsupported native session action') }
  if (!state?.sessionId || typeof req.expectedSessionId !== 'string' || req.expectedSessionId !== state.sessionId) {
    return { ok: false, error: pick('会话已切换，请重新打开操作面板', 'Session changed; reopen the panel') }
  }
  for (const key of ['args', 'entryId', 'since', 'parentSession']) {
    if (req[key] !== undefined && (typeof req[key] !== 'string' || (req[key] as string).length > 32_768)) {
      return { ok: false, error: pick('原生会话参数无效', 'Invalid native session parameters') }
    }
  }
  if ((req.action === 'navigate' || req.action === 'set-label') && (typeof req.entryId !== 'string' || !req.entryId.trim())) return { ok: false, error: pick('缺少会话树目标条目', 'Missing session tree target entry') }
  if (req.summarize !== undefined && typeof req.summarize !== 'boolean') return { ok: false, error: pick('原生会话参数无效', 'Invalid native session parameters') }
  if (req.label !== undefined && (typeof req.label !== 'string' || req.label.length > 200)) return { ok: false, error: pick('书签名称无效', 'Invalid bookmark name') }
  if (req.action === 'set-trust' && typeof req.trusted !== 'boolean') return { ok: false, error: pick('必须明确选择信任或不信任', 'Choose trust or not trust explicitly') }
  if (req.action === 'set-scoped-models' && (!Array.isArray(req.modelIds) || req.modelIds.length > 500 || req.modelIds.some(id => typeof id !== 'string' || !id || id.length > 1024))) {
    return { ok: false, error: pick('模型范围无效', 'Invalid model scope') }
  }
  if (MUTATIONS.has(req.action) && (extraBusy || state.isAgentRunning || state.isStreaming || state.isCompacting || state.pendingMessageCount > 0)) {
    return { ok: false, error: pick('当前会话仍在运行、排队或等待答复，请完成后再操作', 'The session is still running, queued or awaiting a reply; try again when it finishes') }
  }
  return { ok: true, request: req as unknown as NativeSessionHostRequest }
}
