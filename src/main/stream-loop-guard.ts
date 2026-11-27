import type { LoopHit, StreamLoopDetector } from '../shared/stream-loop-detector'

export type LoopStream = 'thinking' | 'text'

export function streamLoopGuardEnabled(): boolean {
  return process.env.YAN_STREAM_LOOP_GUARD !== '0'
}

export class StreamLoopGuard {
  detector: StreamLoopDetector | null = null
  tripped = false
  abortSent = false
  stopping = false
  abortedMessage = false
  resumeVersion = -1
  hit?: { rule: LoopHit['rule']; stream: LoopStream }
  stopTask?: Promise<void>
  continueTask?: Promise<boolean>

  get blocking(): boolean {
    return this.stopping || this.abortSent
  }

  get engaged(): boolean {
    return this.tripped || this.abortSent
  }

  trip(hit: LoopHit, stream: LoopStream, version: number): void {
    this.tripped = true
    this.resumeVersion = version
    this.abortedMessage = false
    this.hit = { rule: hit.rule, stream }
  }

  clear(): void {
    this.detector = null
    this.tripped = false
    this.abortSent = false
    this.stopping = false
    this.abortedMessage = false
    this.hit = undefined
  }
}

export class AutoContinueBudget {
  version = 0
  used = 0

  get spent(): boolean {
    return this.used >= 1
  }

  invalidate(): void {
    this.version += 1
  }

  restart(): void {
    this.version += 1
    this.used = 0
  }

  consume(): void {
    this.used += 1
  }
}
