/**
 * 网页搜索引擎来源的公共骨架：在隐藏页面里打开结果页，跑一段页面脚本读结果列表。
 *
 * 各引擎（Bing / DuckDuckGo / 360）只提供结果页地址、读取脚本和行映射。
 * 页面结构变化或弹出验证时如实报 `parse_failed` / `captcha`，不把失败写成「没有结果」；
 * 引擎自己说「没有结果」才返回空数组。
 */
import type { SourceRun } from './aggregate'
import type { SearchSourceId } from '../../shared/search'
import { HiddenPageTimeout, withHiddenPage } from './hidden-page'

export interface EnginePage<Raw> {
  items: Raw[]
  /** 出现了人机验证 */
  captcha: boolean
  /** 引擎明确显示「没有结果」 */
  none: boolean
}

export interface WebEngine<Raw> {
  source: SearchSourceId
  label: string
  url: string
  /** 在页面里执行，返回 EnginePage<Raw> */
  script: string
  toRow(raw: Raw): { title: string; url: string; snippet: string }
}

export async function runWebEngine<Raw>(engine: WebEngine<Raw>, opts: { timeoutMs: number }): Promise<SourceRun> {
  const started = Date.now()
  const elapsed = (): number => Date.now() - started
  const fail = (code: string, message: string, timedOut = false): SourceRun => ({
    source: engine.source,
    rows: null,
    ...(timedOut ? { timedOut: true } : {}),
    error: { code, message },
    elapsedMs: elapsed()
  })
  try {
    return await withHiddenPage(opts.timeoutMs, async (win) => {
      /*
       * 不等整页加载完：结果是服务端渲染的，慢站点的广告 / 统计脚本会把
       * did-finish-load 拖到十几秒。边加载边轮询结果列表，出现就走。
       * 「没有结果」要连续 3 秒都看到才算数 —— Bing 的重定向中间页也会显示它。
       */
      let loadError = ''
      void win.loadURL(engine.url).catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) loadError = e.message
      })
      let noneStreak = 0
      for (;;) {
        if (loadError) return fail('network_error', loadError)
        let page: EnginePage<Raw> | null = null
        try {
          page = (await win.webContents.executeJavaScript(engine.script)) as EnginePage<Raw>
        } catch {
          /* 正在跳转，下一轮再试 */
        }
        if (page?.captcha) return fail('captcha', `${engine.label} 要求人机验证，暂时不可用`)
        if (page && page.items.length > 0) {
          return { source: engine.source, rows: page.items.map((r) => engine.toRow(r)), elapsedMs: elapsed() } satisfies SourceRun
        }
        noneStreak = page?.none ? noneStreak + 1 : 0
        if (noneStreak >= 10) return { source: engine.source, rows: [], elapsedMs: elapsed() } satisfies SourceRun
        await new Promise((r) => setTimeout(r, 300))
      }
    })
  } catch (e) {
    if (e instanceof HiddenPageTimeout) return fail('timeout', e.message, true)
    return fail('network_error', e instanceof Error ? e.message : String(e))
  }
}
