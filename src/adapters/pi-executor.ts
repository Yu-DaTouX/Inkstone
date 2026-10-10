import { PiRpc } from '../main/protocol'
import type { ServiceTask } from '../shared/agent-service'

export interface PiExecutorOptions {
  runtime: { executable: string; cli: string; kind: 'node' | 'electron' }
  piDir: string
  sessionDir: string
  guardExtension: string
  provider: string
  model: string
  authorityUrl: string
  authorityToken: string
}

/** Uses the existing JSONL client and official pi model/session loop. */
export class PiExecutor {
  readonly rpc: PiRpc
  constructor(task: ServiceTask, options: PiExecutorOptions) {
    const env: NodeJS.ProcessEnv = {}
    // Preserve only OS runtime necessities; provider tokens never inherit implicitly.
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    Object.assign(env, { PI_CODING_AGENT_DIR: options.piDir, PI_OFFLINE: '1', INKSTONE_AUTHORITY_URL: options.authorityUrl, INKSTONE_AUTHORITY_TOKEN: options.authorityToken, INKSTONE_TASK_ID: task.id, INKSTONE_GENERATION: String(task.generation) })
    this.rpc = new PiRpc({ runtime: options.runtime, cwd: task.workspace, inheritEnv: false, env, args: [
      '--provider', options.provider, '--model', options.model,
      '--no-extensions', '--no-skills', '--tools', 'read,write,edit',
      '--extension', options.guardExtension, '--session-dir', options.sessionDir,
      ...(task.sessionFile ? ['--session', task.sessionFile] : []),
      '--append-system-prompt', 'Work only with the authorized inputs/ and outputs/ directories. Inputs are copies and read-only. Put deliverable files in outputs/. Shell, network tools and external connectors are unavailable. Do not alter runtime metadata. Report tool failures accurately.'
    ] })
  }
  async start(): Promise<void> {
    this.rpc.spawn()
    const state = await this.rpc.command('get_state', {}, { timeoutMs: 20_000 })
    if (!state.success) throw new Error(state.error ?? 'pi 未就绪')
  }
  async prompt(message: string): Promise<void> {
    const result = await this.rpc.command('prompt', { message })
    if (!result.success) throw new Error(result.error ?? 'pi 拒绝消息')
  }
  async cancel(): Promise<void> { await this.rpc.command('abort', {}, { timeoutMs: 5000 }).catch(() => undefined); await this.rpc.close() }
}
