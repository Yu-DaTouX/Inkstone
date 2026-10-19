import { readFileSync } from 'node:fs'

export function hostToolsAvailable(env = process.env) {
  return !!(env.YAN_RUNNER_ID && env.YAN_CLI_URL && env.YAN_CLI_TOKEN && env.YAN_SESSION_ID && env.YAN_PROJECT_ID)
}

export function toolText(text, details = {}, isError = false) {
  return { content: [{ type: 'text', text }], details, ...(isError ? { isError: true } : {}) }
}

function readResult(path) {
  if (typeof path !== 'string' || !path) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function callHostTool({ command, params, toolCallId, cwd, signal, env = process.env, fetchImpl = fetch }) {
  if (!hostToolsAvailable(env)) return { ok: false, error: 'Inkstone host endpoint is not ready' }
  let response
  try {
    response = await fetchImpl(env.YAN_CLI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.YAN_CLI_TOKEN}` },
      body: JSON.stringify({
        apiVersion: 1,
        command,
        params: { ...params, toolCall: { id: toolCallId, cwd: cwd ?? '', subagent: false } },
        sessionId: env.YAN_SESSION_ID,
        projectId: env.YAN_PROJECT_ID
      }),
      signal
    })
  } catch (error) {
    const cancelled = signal?.aborted === true || error?.name === 'AbortError'
    return { ok: false, cancelled, error: cancelled ? 'cancelled' : String(error?.message ?? error) }
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: 'host returned non-JSON' }
  }
  const data = readResult(payload?.resultFile)
  if (!payload?.ok) return { ok: false, error: String(payload?.error ?? 'host error'), code: payload?.code, data }
  return { ok: true, summary: payload.summary ?? {}, data }
}
