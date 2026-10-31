import { READ_PAGE_MAX_CHARS_DEFAULT, READ_PAGE_MAX_CHARS_MAX, PAGE_SNAPSHOT_MAX_CHARS, normalizeReadUrl, assertReadablePage, ReadPageError, type ReadPageResult } from './page-types'
export { READ_PAGE_MAX_CHARS_DEFAULT, READ_PAGE_MAX_CHARS_MAX, PAGE_SNAPSHOT_MAX_CHARS, normalizeReadUrl, assertReadablePage, ReadPageError, type ReadPageResult } from './page-types'
import { HiddenPageCancelled, HiddenPageTimeout, sleepUnlessAborted, withHiddenPage } from './hidden-page'
import { fetchPublicPage } from './public-page'
import { parseWebContent } from './web-content'

const EXTRACT = `(() => ({ title: document.title || '', finalUrl: location.href, html: document.documentElement.outerHTML.slice(0, 2000001), text: document.body?.innerText || '', state: document.readyState }))()`

export async function readPage(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal; snapshot?: boolean } = {}
): Promise<ReadPageResult> {
  const url = normalizeReadUrl(rawUrl)
  const maxChars = opts.snapshot ? PAGE_SNAPSHOT_MAX_CHARS : Math.min(READ_PAGE_MAX_CHARS_MAX, Math.max(500, Math.round(opts.maxChars ?? READ_PAGE_MAX_CHARS_DEFAULT)))
  const timeoutMs = Math.min(60_000, Math.max(3_000, Math.round(opts.timeoutMs ?? 20_000)))
  const deadline = Date.now() + timeoutMs
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const finish = (page: ReadPageResult): ReadPageResult => assertReadablePage({ ...page, fetchedAt: new Date().toISOString(), text: page.text.slice(0, maxChars), truncated: page.truncated || page.text.length > maxChars })
  let staticPage: ReadPageResult | undefined
  try {
    signal.throwIfAborted()
    try {
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, 5000))])
      const fetched = await fetchPublicPage(url, attempt)
      const { contentType, body, finalUrl } = fetched
      if (contentType.includes('application/pdf') || new TextDecoder().decode(body.slice(0, 5)) === '%PDF-') {
        const pdf = await parseWebContent({ kind: 'pdf', data: body, maxChars }, signal)
        return finish({ ...pdf, url, finalUrl, contentType, format: 'text', extraction: 'pdf', truncated: pdf.truncated ?? false, totalChars: pdf.totalChars ?? pdf.text.length })
      }
      if (!contentType || /text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json/.test(contentType)) {
        const charset = contentType.match(/charset=["']?([^;\s"']+)/)?.[1] ?? 'utf-8'
        let text: string
        try { text = new TextDecoder(charset).decode(body) } catch { text = new TextDecoder().decode(body) }
        const html = /html/.test(contentType) || (!contentType && /<(?:html|body|main|article)[\s>]/i.test(text))
        const extracted = html ? await parseWebContent({ kind: 'html', html: text, url: finalUrl }, signal) : { title: '', text }
        staticPage = finish({ ...extracted, url, finalUrl, totalChars: extracted.text.length, truncated: false, contentType, format: html ? 'markdown' : 'text', extraction: html ? 'html' : 'text' })
        if (staticPage.text.length >= 200 || !html) return staticPage
      } else throw new ReadPageError('unsupported_type', `不支持的网页内容类型：${contentType}`)
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ReadPageError && ['private_host', 'bad_url', 'too_large', 'unsupported_type', 'pdf_no_text'].includes(error.code)) throw error
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new ReadPageError('timeout', `超过 ${timeoutMs}ms 没有返回`)
    return await withHiddenPage(remaining, async (win, browserSignal) => {
      let loadError = ''
      let status = 0
      win.webContents.on('did-navigate', (_event, _url, code) => { status = code })
      void win.loadURL(url).catch((e: Error) => {
        if (!/ERR_ABORTED/.test(e.message)) loadError = e.message
      })
      type Snapshot = { title: string; finalUrl: string; text: string; html?: string; state: string }
      let last = null as Snapshot | null
      let stable = 0
      let prevLen = -1
      for (;;) {
        if (browserSignal.aborted) throw new HiddenPageTimeout(timeoutMs)
        if (loadError) throw new ReadPageError('network_error', loadError)
        if (status >= 400) throw new ReadPageError('http_error', `网页返回 HTTP ${status}，未取得正文`)
        try {
          last = (await win.webContents.executeJavaScript(EXTRACT)) as Snapshot
        } catch {
        }
        if (last && last.text.length > 0 && last.finalUrl !== 'about:blank') {
          stable = last.text.length === prevLen ? stable + 1 : 0
          prevLen = last.text.length
          if (last.state === 'complete' || stable >= 4) break
        }
        await sleepUnlessAborted(400, browserSignal)
      }
      const done = last as Snapshot
      const extracted = done.html ? await parseWebContent({ kind: 'html', html: done.html, url: done.finalUrl }, signal) : { title: done.title, text: done.text }
      if (staticPage && staticPage.text.length > extracted.text.length) return staticPage
      return finish({
        ...extracted,
        url,
        finalUrl: normalizeReadUrl(done.finalUrl),
        title: extracted.title || done.title.trim(),
        truncated: false,
        totalChars: extracted.text.length,
        format: 'markdown',
        extraction: 'browser',
        contentType: 'text/html'
      })
    }, signal)
  } catch (e) {
    if (opts.signal?.aborted) throw new ReadPageError('cancelled', '已取消网页读取')
    if (signal.aborted || e instanceof HiddenPageTimeout) throw new ReadPageError('timeout', `超过 ${timeoutMs}ms 没有返回`)
    if (e instanceof HiddenPageCancelled) throw new ReadPageError('cancelled', '已取消网页读取')
    if (e instanceof ReadPageError) throw e
    if (e instanceof HiddenPageTimeout) throw new ReadPageError('timeout', e.message)
    throw new ReadPageError('network_error', e instanceof Error ? e.message : String(e))
  }
}
