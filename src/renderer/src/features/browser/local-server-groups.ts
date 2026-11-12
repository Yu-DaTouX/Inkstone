import type { LocalServerInfo } from '../../../../shared/local-servers'

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::'])

export function isOtherLocalServer(server: Pick<LocalServerInfo, 'host' | 'title' | 'agentStarted'>): boolean {
  return !server.agentStarted && !server.title && WILDCARD_HOSTS.has(server.host)
}

export function groupLocalServers<T extends Pick<LocalServerInfo, 'host' | 'title' | 'agentStarted'>>(servers: readonly T[]): { main: T[]; other: T[] } {
  const main: T[] = []
  const other: T[] = []
  for (const server of servers) (isOtherLocalServer(server) ? other : main).push(server)
  return { main, other }
}

export function localServerMarkName(server: Pick<LocalServerInfo, 'title' | 'processName' | 'port'>): string {
  return server.title?.trim() || server.processName?.trim() || String(server.port)
}
