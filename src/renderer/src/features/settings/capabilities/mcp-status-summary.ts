import { pick } from '../../../../../shared/ui-lang'
import type { CapabilityMcpServerSettingView } from '../../../../../shared/ipc'

export type McpStatusKind = 'ready' | 'connecting' | 'error' | 'needs-auth' | 'in-use-elsewhere' | 'checked-ok' | 'checked-failed' | 'unchecked'

export interface McpStatusSummary {
  kind: McpStatusKind
  short: string
  detail: string
}

type Facts = Pick<CapabilityMcpServerSettingView, 'status' | 'connectedSessions' | 'lastCheck'> & { ownedBy?: CapabilityMcpServerSettingView['ownedBy'] }

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return pick('刚刚', 'just now')
  if (minutes < 60) return pick(`${minutes} 分钟前`, `${minutes} min ago`)
  if (minutes < 1440) return pick(`${Math.floor(minutes / 60)} 小时前`, `${Math.floor(minutes / 60)} h ago`)
  return pick(`${Math.floor(minutes / 1440)} 天前`, `${Math.floor(minutes / 1440)} d ago`)
}

export function summarizeMcpStatus(facts: Facts, now = Date.now()): McpStatusSummary {
  const sessions = facts.connectedSessions ?? 0
  if (facts.status === 'ready') {
    const others = Math.max(0, sessions - 1)
    return {
      kind: 'ready',
      short: pick('已连接', 'Connected'),
      detail: others > 0
        ? pick(`本会话已连接，另有 ${others} 个会话也在用。`, `Connected in this session; ${others} other ${plural(others, 'session is', 'sessions are')} using it too.`)
        : pick('本会话已连接。', 'Connected in this session.')
    }
  }
  if (facts.status === 'connecting') return { kind: 'connecting', short: pick('连接中', 'Connecting'), detail: pick('正在连接。', 'Connecting.') }
  if (facts.status === 'error') {
    return { kind: 'error', short: pick('连接错误', 'Connection error'), detail: pick('本会话的连接出错，可点「检查连接」查看原因。', 'The connection in this session failed. Use Check connection to see why.') }
  }
  if (facts.status === 'needs-auth') return { kind: 'needs-auth', short: pick('需要认证', 'Authentication required'), detail: pick('服务要求认证。', 'The service requires authentication.') }
  if (sessions > 0) {
    return {
      kind: 'in-use-elsewhere',
      short: pick(`${sessions} 个会话在用`, `In use by ${sessions} ${plural(sessions, 'session', 'sessions')}`),
      detail: pick(`本会话还没连接，但有 ${sessions} 个会话正在使用。`, `Not connected in this session yet, but ${sessions} ${plural(sessions, 'session is', 'sessions are')} using it.`)
    }
  }
  const check = facts.lastCheck
  if (check?.ok) {
    const tools = check.toolCount === undefined ? '' : pick(`（${check.toolCount} 个工具）`, ` (${check.toolCount} tools)`)
    return {
      kind: 'checked-ok',
      short: pick('检查通过', 'Check passed'),
      detail: pick(`最近一次检查通过${tools}，${ago(check.at, now)}；连接在使用时按需建立。`, `Last check passed${tools}, ${ago(check.at, now)}. It connects on demand when used.`)
    }
  }
  if (check) {
    return {
      kind: 'checked-failed',
      short: pick('检查失败', 'Check failed'),
      detail: pick(`最近一次检查失败，${ago(check.at, now)}${check.error ? `：${check.error}` : ''}。`, `Last check failed, ${ago(check.at, now)}${check.error ? `: ${check.error}` : ''}.`)
    }
  }
  if (facts.ownedBy === 'inkstone') {
    return {
      kind: 'unchecked',
      short: pick('未检查', 'Not checked'),
      detail: pick('由砚托管：所有会话共用一个连接，由砚在首次调用工具时建立。这里没有连接记录，不代表连不上；可点「检查连接」确认。', 'Hosted by Inkstone: all sessions share one connection, which Inkstone opens on the first tool call. There is no connection record here, which does not mean it cannot connect; use Check connection to confirm.')
    }
  }
  return {
    kind: 'unchecked',
    short: pick('未检查', 'Not checked'),
    detail: pick('已配置，尚未检查；连接在首次使用时按需建立，这里不代表连不上。', 'Configured but not checked. It connects on first use, so this does not mean it cannot connect.')
  }
}
