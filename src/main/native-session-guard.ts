import type { NativeSessionHostRequest } from '../shared/native-session-host'
import type { SessionState } from '../shared/ipc'

const ACTIONS = new Set([
  'tree', 'entries', 'navigate', 'reload', 'scoped-models', 'set-scoped-models',
  'trust', 'set-trust', 'import', 'export-jsonl', 'share', 'new-session'
])
const MUTATIONS = new Set(['navigate', 'reload', 'set-scoped-models', 'set-trust', 'import', 'new-session', 'share', 'export-jsonl'])

export function validateNativeSessionRequest(
  input: unknown,
  state: SessionState | null,
  extraBusy = false
): { ok: true; request: NativeSessionHostRequest } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '原生会话请求无效' }
  const req = input as Record<string, unknown>
  if (typeof req.action !== 'string' || !ACTIONS.has(req.action)) return { ok: false, error: '不支持的原生会话操作' }
  if (!state?.sessionId || typeof req.expectedSessionId !== 'string' || req.expectedSessionId !== state.sessionId) {
    return { ok: false, error: '会话已切换，请重新打开操作面板' }
  }
  for (const key of ['args', 'entryId', 'since', 'parentSession']) {
    if (req[key] !== undefined && (typeof req[key] !== 'string' || (req[key] as string).length > 32_768)) {
      return { ok: false, error: '原生会话参数无效' }
    }
  }
  if (req.action === 'navigate' && (typeof req.entryId !== 'string' || !req.entryId.trim())) return { ok: false, error: '缺少会话树目标条目' }
  if (req.action === 'set-trust' && typeof req.trusted !== 'boolean') return { ok: false, error: '必须明确选择信任或不信任' }
  if (req.action === 'set-scoped-models' && (!Array.isArray(req.modelIds) || req.modelIds.length > 500 || req.modelIds.some(id => typeof id !== 'string' || !id || id.length > 1024))) {
    return { ok: false, error: '模型范围无效' }
  }
  if (MUTATIONS.has(req.action) && (extraBusy || state.isAgentRunning || state.isStreaming || state.isCompacting || state.pendingMessageCount > 0)) {
    return { ok: false, error: '当前会话仍在运行、排队或等待答复，请完成后再操作' }
  }
  return { ok: true, request: req as unknown as NativeSessionHostRequest }
}
