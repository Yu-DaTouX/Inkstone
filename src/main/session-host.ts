/**
 * 桌面会话的宿主能力：运行注册表、当前前台实例、会话链、推送、cwd 校验、
 * 启动 pi、登记运行实例与读带成果的历史。
 *
 * 桌面 IPC（ipc/session-ipc.ts）与远程入口（remote-host.ts）拿到的是同一组能力，
 * 新增入口时复用它，而不是各自复制会话规则。实现都在应用入口。
 */
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
  startAgent(restore?: { sessionFile?: string }): Promise<{ ok: boolean; error?: string }>
  rememberRunnerSession(
    result: { ok: boolean; id?: string; sessionId?: string },
    target: { sessionFile?: string; projectId?: string; scope?: 'global' | 'project' | 'pending'; cwd: string }
  ): Promise<void>
  readHistoryWithArtifacts(sessionFile: string): ReturnType<typeof readChainMessages>
  projectIdForCwd(settings: Awaited<ReturnType<typeof getSettings>>, cwd: string): string | undefined
}
