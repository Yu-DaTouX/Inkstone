import type { SearchSourceId } from '../../shared/search'
import type { SourceRun } from './aggregate'

const COOLDOWN_MS: Record<string, number> = {
  insufficient_balance: 15 * 60_000,
  api_key_rejected: 15 * 60_000,
  captcha: 10 * 60_000,
  rate_limited: 2 * 60_000
}

const REASON: Record<string, string> = {
  insufficient_balance: '余额不足',
  api_key_rejected: '密钥被拒绝',
  captcha: '要求人机验证',
  rate_limited: '被限流'
}

export interface CoolingSource {
  until: number
  code: string
}

export class SourceCooldown {
  private readonly cooling = new Map<SearchSourceId, CoolingSource>()

  check(source: SearchSourceId, now: number): CoolingSource | null {
    const hit = this.cooling.get(source)
    if (!hit) return null
    if (hit.until <= now) {
      this.cooling.delete(source)
      return null
    }
    return hit
  }

  record(run: SourceRun, now: number): void {
    if (run.skipped) return
    const code = run.error?.code ?? ''
    const span = COOLDOWN_MS[code]
    if (span) this.cooling.set(run.source, { until: now + span, code })
    else if (run.rows && run.rows.length) this.cooling.delete(run.source)
  }

  skippedRun(source: SearchSourceId, hit: CoolingSource, now: number): SourceRun {
    const minutes = Math.max(1, Math.ceil((hit.until - now) / 60_000))
    return {
      source,
      rows: null,
      skipped: true,
      elapsedMs: 0,
      error: { code: 'cooldown', message: `上次${REASON[hit.code] ?? '出错'}，冷却中（约 ${minutes} 分钟后再试；用 --sources 点名可强制使用）` }
    }
  }
}
