import { isLiveTerminalJob, terminalJobOwnedBy } from '../shared/terminal-jobs'
import { listTerminalJobs } from './terminal-jobs'
import { HELD_TERMINAL_NOTICES_MAX, terminalNoticeStep } from './terminal-notice-step'

const RETRY_MS = 3000
const GIVE_UP_MS = 2 * 3600_000
const MAX_FAILURES = 5

export interface TerminalNoticeSession {
  stopping: boolean
  ready: boolean
  running: boolean
}

export interface TerminalNoticeDeliveryDeps {
  session(): TerminalNoticeSession
  ownerKeys(): string[]
  steer(text: string): Promise<{ ok: boolean }>
  followUp(text: string): Promise<{ ok: boolean }>
  submitHeld(text: string): Promise<unknown>
  wait?(ms: number): Promise<void>
}

export class TerminalNoticeDelivery {
  private pending = 0
  private held: { text: string; stillOwner: () => boolean }[] = []

  constructor(private readonly deps: TerminalNoticeDeliveryDeps) {}

  async deliver(text: string, stillOwner: () => boolean, wake: boolean): Promise<void> {
    this.pending += 1
    try {
      let failures = 0
      for (let waited = 0; waited < GIVE_UP_MS && failures < MAX_FAILURES; waited += RETRY_MS) {
        const step = terminalNoticeStep({ ...this.deps.session(), owned: stillOwner(), wake })
        if (step === 'drop') return
        if (step === 'hold') {
          this.held = [...this.held, { text, stillOwner }].slice(-HELD_TERMINAL_NOTICES_MAX)
          return
        }
        if (step !== 'wait') {
          const result = await (step === 'steer' ? this.deps.steer(text) : this.deps.followUp(text)).catch(() => ({ ok: false }))
          if (result.ok) return
          failures += 1
        }
        await (this.deps.wait ? this.deps.wait(RETRY_MS) : new Promise<void>((done) => setTimeout(done, RETRY_MS)))
      }
      console.warn('[agent] 后台终端通知未能投递')
    } finally {
      this.pending -= 1
    }
  }

  async flushHeld(): Promise<void> {
    const held = this.held
    this.held = []
    for (const item of held) {
      if (!item.stillOwner()) continue
      await this.deps.submitHeld(item.text).catch(() => undefined)
    }
  }

  hasPendingWork(): boolean {
    if (this.pending > 0) return true
    const keys = this.deps.ownerKeys()
    if (!keys.length) return false
    return listTerminalJobs().some((job) => isLiveTerminalJob(job) && keys.some((key) => terminalJobOwnedBy(job, key)))
  }
}
