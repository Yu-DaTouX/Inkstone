import type { AgentController } from './agent'
import type { RunnerRegistry } from './runners'
import type { SessionChainStore } from './session-chain-service'
import type { readChainMessages } from './session-history'
import type { getSettings } from './settings'
import type { MainPush } from '../shared/ipc'

export interface SessionHost {
  runners(): RunnerRegistry | null
  ac(): AgentController | null
  sessionChains: SessionChainStore
  push(msg: MainPush): void
  pushRunners(): void
  pushRunnerSnapshot(id: string, opts?: { chainHistory?: boolean }): Promise<void>
  validateCwd(cwd: unknown): Promise<{ ok: true; cwd: string } | { ok: false; error: string }>
  relocateMissingCwd?(missing: string): Promise<string | null>
  startAgent(restore?: { sessionFile?: string }): Promise<{ ok: boolean; error?: string }>
  rememberRunnerSession(
    result: { ok: boolean; id?: string; sessionId?: string },
    target: { sessionFile?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }
  ): Promise<void>
  readHistoryWithArtifacts(sessionFile: string): ReturnType<typeof readChainMessages>
  projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined
}
