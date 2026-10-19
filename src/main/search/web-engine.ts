import type { SourceRun } from './aggregate'
import type { SearchSourceId } from '../../shared/search'
import { HiddenPageTimeout, sleepUnlessAborted, withHiddenPage } from './hidden-page'

export interface EnginePage<Raw> {
  items: Raw[]
  captcha: boolean
  none: boolean
}

export interface WebEngine<Raw> {
  source: SearchSourceId
  label: string
  url: string
  script: string
  toRow(raw: Raw): { title: string; url: string; snippet: string }
}

export async function runWebEngine<Raw>(engine: WebEngine<Raw>, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<SourceRun> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const fail = (code: string, message: string, timedOut = false): SourceRun =>
    opts.signal?.aborted
      ? { source: engine.source, rows: null, skipped: true, elapsedMs: elapsed() }
      : {
          source: engine.source,
          rows: null,
          ...(timedOut ? { timedOut: true } : {}),
          error: { code, message },
          elapsedMs: elapsed()
        }
  try {
    return await withHiddenPage(opts.timeoutMs, async (win, signal) => {
      let loadError = ''
      void win.loadURL(engine.url).catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) loadError = e.message
      })
      let noneStreak = 0
      for (;;) {
        if (signal.aborted) return fail('timeout', `超过 ${opts.timeoutMs}ms 没有返回`, true)
        if (loadError) return fail('network_error', loadError)
        let page: EnginePage<Raw> | null = null
        try {
          page = (await win.webContents.executeJavaScript(engine.script)) as EnginePage<Raw>
        } catch {
        }
        if (page?.captcha) return fail('captcha', `${engine.label} 要求人机验证，暂时不可用`)
        if (page && page.items.length > 0) {
          return { source: engine.source, rows: page.items.map((r) => engine.toRow(r)), elapsedMs: elapsed() } satisfies SourceRun
        }
        noneStreak = page?.none ? noneStreak + 1 : 0
        if (noneStreak >= 10) return { source: engine.source, rows: [], elapsedMs: elapsed() } satisfies SourceRun
        await sleepUnlessAborted(300, signal)
      }
    }, opts.signal)
  } catch (e) {
    if (e instanceof HiddenPageTimeout) return fail('timeout', e.message, true)
    return fail('network_error', e instanceof Error ? e.message : String(e))
  }
}
