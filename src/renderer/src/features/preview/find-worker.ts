import { findMatches, type LineFindRequest } from './code-find'
import { pdfFindMatches, type PdfFindRequest } from './pdf-find'

type FindWorkerRequest = LineFindRequest | PdfFindRequest

const scope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<FindWorkerRequest>) => void): void
  postMessage(data: unknown): void
}

scope.addEventListener('message', (event) => {
  const request = event.data
  const result =
    request.kind === 'pdf'
      ? pdfFindMatches(request.pages, request.query, request.options, request.limit)
      : findMatches(request.texts, request.query, request.options, request.limit)
  scope.postMessage(result)
})
