import { extractHtml } from './search/html-content'
import { extractPdf } from './search/pdf-content'
import { ReadPageError } from './search/page-types'
import type { WebContentJob } from './search/web-content'

process.parentPort.on('message', async (event: { data: WebContentJob }) => {
  try {
    const job = event.data
    const data = job.kind === 'html' ? extractHtml(job.html, job.url) : await extractPdf(job.data, new AbortController().signal, job.maxChars)
    process.parentPort.postMessage({ data })
  } catch (error) {
    process.parentPort.postMessage({ error: error instanceof Error ? error.message : String(error), code: error instanceof ReadPageError ? error.code : 'parse_error' })
  }
})
