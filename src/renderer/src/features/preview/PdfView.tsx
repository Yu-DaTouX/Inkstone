import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, FileWarning, FolderOpen, Lock, X, ZoomIn, ZoomOut } from 'lucide-react'
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy
} from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Button, EmptyState, IconButton, Input, Skeleton, TextField } from '../../ui'
import {
  compileFind,
  findShortcut,
  findStatus,
  findStepKey,
  rememberedFindOptions,
  rememberFindOptions,
  stepFindIndex,
  type FindOptions
} from './code-find'
import { pdfFindMatches, pdfMatchPage, pdfTextLines } from './pdf-find'
import {
  PDF_LAZY_MARGIN,
  PDF_PAGE_GAP,
  PDF_PAGE_PADDING,
  pdfClampZoom,
  pdfCurrentPage,
  pdfFitWidthScale,
  pdfPageTops,
  pdfPageWindow,
  pdfScaledHeights,
  pdfZoomStep,
  type PdfPageWindow
} from './pdf-view'
import type { PreviewText } from './preview-text'

const MAC = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || '')

const WORKER_URL = new URL(workerSrc, document.baseURI).href

let worker: Worker | null = null
const FIND_TEXT_CACHE = new WeakMap<PDFDocumentProxy, string[][]>()
try {
  worker = new Worker(WORKER_URL, { type: 'module' })
  GlobalWorkerOptions.workerPort = worker
} catch {
  worker = null
}

type PdfStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed' }
  | { kind: 'password' }
  | { kind: 'too-large' }

interface PdfLoadState {
  status: PdfStatus['kind']
}

export function PdfView({
  name,
  abs,
  cwd,
  labels,
  onOpen
}: {
  name: string
  abs: string
  cwd?: string
  labels: PreviewText
  onOpen: () => void
}): ReactElement {
  const [load, setLoad] = useState<PdfLoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [count, setCount] = useState(0)
  const [sizes, setSizes] = useState<{ width: number; height: number }[]>([])
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [width, setWidth] = useState(0)
  const [pageWindow, setPageWindow] = useState<PdfPageWindow>({ first: 0, last: 0 })
  const [rendered, setRendered] = useState<number[]>([])
  const [bar, setBar] = useState<'find' | null>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<FindOptions>(rememberedFindOptions)
  const [findIndex, setFindIndex] = useState(0)
  const [pagesText, setPagesText] = useState<string[][] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    let task: PDFDocumentLoadingTask | null = null
    setLoad({ status: 'loading' })
    setDoc(null)
    setCount(0)
    setSizes([])
    setPage(1)
    setRendered([])
    setPagesText(null)
    void (async () => {
      if (!worker) {
        if (live) setLoad({ status: 'failed' })
        return
      }
      const file = await window.yan.readPreviewBytes(abs, cwd)
      if (!live) return
      if (!file.ok || !file.bytes) {
        setLoad({ status: file.issue === 'too_large' ? 'too-large' : 'failed' })
        return
      }
      task = getDocument({ data: file.bytes, useSystemFonts: true })
      try {
        const loaded = await task.promise
        if (!live) {
          void task.destroy()
          return
        }
        const first = await loaded.getPage(1)
        const base = first.getViewport({ scale: 1 })
        if (!live) {
          void task.destroy()
          return
        }
        setSizes([{ width: base.width, height: base.height }])
        setCount(loaded.numPages)
        setDoc(loaded)
        setLoad({ status: 'ready' })
      } catch (error) {
        if (!live) return
        setLoad({ status: isPasswordError(error) ? 'password' : 'failed' })
      }
    })()
    return () => {
      live = false
      void task?.destroy()
    }
  }, [abs, cwd, attempt])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [load.status])

  const base = sizes[0]
  const scale = fitWidth && base ? pdfFitWidthScale(width - PDF_PAGE_PADDING * 2 - 1, base.width) : pdfClampZoom(zoom)
  const heights = useMemo(() => pdfScaledHeights(sizes, count, scale), [sizes, count, scale])
  const tops = useMemo(() => pdfPageTops(heights, PDF_PAGE_GAP, PDF_PAGE_PADDING), [heights])

  const goToPage = useCallback(
    (target: number): void => {
      const el = scrollRef.current
      const index = Math.max(0, Math.min(count - 1, target - 1))
      if (!el || !count) return
      el.scrollTop = Math.max(0, (tops[index] ?? 0) - PDF_PAGE_PADDING)
      setPage(index + 1)
    },
    [count, tops]
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !doc) return undefined
    const update = (): void => {
      const next = pdfPageWindow(tops, heights, el.scrollTop, el.clientHeight, PDF_LAZY_MARGIN)
      setPageWindow((prev) => (prev.first === next.first && prev.last === next.last ? prev : next))
      const current = pdfCurrentPage(tops, el.scrollTop + PDF_PAGE_PADDING) + 1
      setPage((prev) => (prev === current ? prev : current))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [doc, tops, heights])

  useEffect(() => {
    if (!doc) return
    const next: number[] = []
    for (let index = pageWindow.first; index <= pageWindow.last; index += 1) next.push(index)
    setRendered((prev) =>
      prev.length === next.length && next.every((value, index) => value === prev[index]) ? prev : next
    )
  }, [doc, pageWindow])

  useEffect(() => {
    if (bar !== 'find' || pagesText || !doc) return
    const cached = FIND_TEXT_CACHE.get(doc)
    if (cached) {
      setPagesText(cached)
      return
    }
    let live = true
    void (async () => {
      const lines: string[][] = []
      for (let number = 1; number <= doc.numPages; number += 1) {
        const pdfPage = await doc.getPage(number)
        const content = await pdfPage.getTextContent()
        lines.push(pdfTextLines(content.items.filter((item) => 'str' in item)))
        if (!live) return
      }
      FIND_TEXT_CACHE.set(doc, lines)
      if (live) setPagesText(lines)
    })()
    return () => {
      live = false
    }
  }, [bar, doc, pagesText])

  const search = useMemo(
    () => (pagesText ? pdfFindMatches(pagesText, query, options) : { matches: [], invalid: false, capped: false }),
    [pagesText, query, options]
  )
  const status = findStatus(findIndex, search.matches.length, search.capped)
  const activePage = pdfMatchPage(search.matches, findIndex)

  useEffect(() => {
    if (!bar || !search.matches.length) return
    goToPage(activePage + 1)
  }, [bar, activePage, search.matches.length, goToPage])

  useEffect(() => {
    if (bar === 'find') {
      findRef.current?.focus()
      findRef.current?.select()
    }
  }, [bar])

  const reportSize = useCallback((index: number, pageWidth: number, pageHeight: number): void => {
    setSizes((prev) => {
      const existing = prev[index]
      if (existing && Math.abs(existing.width - pageWidth) < 0.5 && Math.abs(existing.height - pageHeight) < 0.5) return prev
      const next = prev.slice()
      next[index] = { width: pageWidth, height: pageHeight }
      return next
    })
  }, [])

  useEffect(() => {
    if (load.status === 'ready') scrollRef.current?.focus()
  }, [load.status])

  const jumpPage = (delta: -1 | 1): void => {
    const el = scrollRef.current
    if (!el) return
    const current = pdfCurrentPage(tops, el.scrollTop + PDF_PAGE_PADDING)
    goToPage(current + 1 + delta)
  }

  const openFind = (): void => {
    setBar('find')
    setFindIndex(0)
  }

  const closeFind = (): void => {
    setBar(null)
  }

  const stepFind = (delta: -1 | 1): void => {
    if (!search.matches.length) return
    setFindIndex((current) => stepFindIndex(current, delta, search.matches.length))
  }

  const toggleOption = (key: keyof FindOptions): void => {
    const next = rememberFindOptions({ ...options, [key]: !options[key] })
    setOptions(next)
    setFindIndex(0)
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    const action = findShortcut(
      { key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey },
      MAC
    )
    if (action === 'open') {
      event.preventDefault()
      event.stopPropagation()
      openFind()
      return
    }
    if (bar && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeFind()
    }
  }

  const onFindInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    const delta = findStepKey(event.key, event.shiftKey)
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    stepFind(delta)
  }

  const zoomBy = (direction: -1 | 1): void => {
    const current = fitWidth ? scale : zoom
    setFitWidth(false)
    setZoom(pdfZoomStep(current, direction))
  }

  if (load.status !== 'ready' || !doc) {
    if (load.status === 'loading') {
      return (
        <div className="v3-pdf-loading" data-testid="v3-preview-pdf-loading" role="status">
          <Skeleton shape="rect" height={420} />
          <span className="v3-preview-hint">{labels.loading}</span>
        </div>
      )
    }
    const message = load.status === 'password' ? labels.pdfPassword : load.status === 'too-large' ? labels.pdfTooLarge : labels.pdfFailed
    const hint = load.status === 'password' ? labels.pdfPasswordHint : load.status === 'too-large' ? labels.pdfTooLargeHint : labels.pdfFailedHint
    return (
      <EmptyState
        className="v3-preview-media-error"
        data-testid={load.status === 'password' ? 'v3-preview-pdf-password' : load.status === 'too-large' ? 'v3-preview-pdf-too-large' : 'v3-preview-pdf-failed'}
        role="alert"
        icon={load.status === 'password' ? <Lock size={20} /> : <FileWarning size={20} />}
        title={message}
        description={hint}
        action={
          <>
            <Button size="sm" variant="primary" icon={<FolderOpen size={14} />} onPress={onOpen}>
              {labels.open}
            </Button>
            <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
              {labels.retry}
            </Button>
          </>
        }
      />
    )
  }

  const percent = `${Math.round(scale * 100)}%`
  const statusText = !query
    ? ''
    : search.invalid
      ? labels.findInvalid
      : !search.matches.length
        ? labels.findNoResults
        : labels.findStatus.replace('{current}', String(status.current)).replace('{total}', `${status.total}${status.capped ? '+' : ''}`)

  return (
    <div className="v3-pdf-view" data-testid="v3-preview-pdf" data-media-format="pdf" onKeyDown={onRootKeyDown}>
      <div className="v3-pdf-bar" role="toolbar" aria-label={labels.pdfToolbar}>
        <IconButton
          size="sm"
          aria-label={labels.pdfPrevPage}
          title={labels.pdfPrevPage}
          isDisabled={page <= 1}
          onPress={() => jumpPage(-1)}
        >
          <ChevronLeft size={14} />
        </IconButton>
        <span className="v3-pdf-count" data-testid="v3-pdf-page">
          {page} / {count}
        </span>
        <IconButton
          size="sm"
          aria-label={labels.pdfNextPage}
          title={labels.pdfNextPage}
          isDisabled={page >= count}
          onPress={() => jumpPage(1)}
        >
          <ChevronRight size={14} />
        </IconButton>
        <span className="v3-pdf-sep" aria-hidden />
        <IconButton size="sm" aria-label={labels.pdfZoomOut} title={labels.pdfZoomOut} onPress={() => zoomBy(-1)}>
          <ZoomOut size={14} />
        </IconButton>
        <Button
          size="sm"
          variant="ghost"
          className="v3-pdf-percent"
          aria-label={labels.pdfZoomReset}
          title={labels.pdfZoomReset}
          onPress={() => {
            setFitWidth(false)
            setZoom(1)
          }}
        >
          {percent}
        </Button>
        <IconButton size="sm" aria-label={labels.pdfZoomIn} title={labels.pdfZoomIn} onPress={() => zoomBy(1)}>
          <ZoomIn size={14} />
        </IconButton>
        <Button
          size="sm"
          variant={fitWidth ? 'secondary' : 'ghost'}
          aria-pressed={fitWidth}
          data-testid="v3-pdf-fit-width"
          onPress={() => setFitWidth(true)}
        >
          {labels.pdfFitWidth}
        </Button>
      </div>
      {bar === 'find' ? (
        <div className="v3-code-bar" role="search" aria-label={labels.find} data-testid="v3-pdf-findbar" onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          event.preventDefault()
          closeFind()
        }}>
          <TextField
            className="v3-code-bar-field"
            size="sm"
            aria-label={labels.find}
            value={query}
            onChange={(value) => {
              setQuery(value)
              setFindIndex(0)
            }}
          >
            <Input
              ref={findRef}
              className="ui-input"
              aria-label={labels.find}
              placeholder={labels.findPlaceholder}
              spellCheck={false}
              autoComplete="off"
              data-testid="v3-pdf-find-input"
              onKeyDown={onFindInputKeyDown}
            />
          </TextField>
          <span className="v3-code-bar-options" role="group" aria-label={labels.find}>
            {([
              ['matchCase', 'Aa', labels.findMatchCase],
              ['wholeWord', 'ab', labels.findWholeWord],
              ['regexp', '.*', labels.findRegexp]
            ] as const).map(([key, glyph, label]) => (
              <IconButton
                key={key}
                size="sm"
                className="v3-code-bar-option"
                aria-label={label}
                title={label}
                aria-pressed={options[key]}
                onPress={() => toggleOption(key)}
              >
                <span aria-hidden className={key === 'wholeWord' ? 'v3-code-bar-word' : undefined}>
                  {glyph}
                </span>
              </IconButton>
            ))}
          </span>
          <span className="v3-code-bar-status" aria-live="polite">
            {statusText}
          </span>
          <IconButton
            size="sm"
            aria-label={labels.findPrev}
            title={labels.findPrev}
            isDisabled={!search.matches.length}
            data-testid="v3-pdf-find-prev"
            onPress={() => stepFind(-1)}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton
            size="sm"
            aria-label={labels.findNext}
            title={labels.findNext}
            isDisabled={!search.matches.length}
            data-testid="v3-pdf-find-next"
            onPress={() => stepFind(1)}
          >
            <ChevronRight size={14} />
          </IconButton>
          <IconButton size="sm" aria-label={labels.findClose} title={labels.findClose} data-testid="v3-pdf-find-close" onPress={closeFind}>
            <X size={13} />
          </IconButton>
        </div>
      ) : null}
      <div ref={scrollRef} className="v3-pdf-scroller" tabIndex={0} aria-label={name} data-testid="v3-pdf-scroller">
        <div className="v3-pdf-pages" style={{ gap: `${PDF_PAGE_GAP}px`, padding: `${PDF_PAGE_PADDING}px` }}>
          {Array.from({ length: count }, (_, index) => {
            const size = sizes[index] ?? base
            const pageWidth = (size?.width ?? 0) * scale
            const pageHeight = (size?.height ?? 0) * scale
            const shouldRender = rendered.includes(index)
            return (
              <div
                key={index}
                className="v3-pdf-page"
                data-page={index + 1}
                style={{ width: `${pageWidth}px`, height: `${pageHeight}px` }}
              >
                {shouldRender ? (
                  <PdfPageCanvas
                    doc={doc}
                    pageNumber={index + 1}
                    scale={scale}
                    query={query}
                    options={options}
                    onSize={reportSize}
                  />
                ) : (
                  <span className="v3-pdf-page-placeholder">{index + 1}</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  query,
  options,
  onSize
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  query: string
  options: FindOptions
  onSize: (index: number, width: number, height: number) => void
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [textVersion, setTextVersion] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    const text = textRef.current
    if (!canvas || !text) return undefined
    let live = true
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null
    text.replaceChildren()
    void (async () => {
      const pdfPage = await doc.getPage(pageNumber)
      if (!live) return
      const viewport = pdfPage.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      task = pdfPage.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
      })
      await task.promise
      if (!live) return
      onSize(pageNumber - 1, viewport.width / scale, viewport.height / scale)
      const content = await pdfPage.getTextContent()
      if (!live) return
      const layer = new TextLayer({ textContentSource: content, container: text, viewport })
      await layer.render()
      if (!live) return
      setTextVersion((value) => value + 1)
    })().catch(() => undefined)
    return () => {
      live = false
      task?.cancel()
    }
  }, [doc, pageNumber, scale, onSize])

  useEffect(() => {
    const text = textRef.current
    if (!text || !query) return
    const matcher = compileFind(query, options)
    const spans = text.querySelectorAll<HTMLElement>('span')
    for (const span of spans) {
      if (!matcher) continue
      matcher.lastIndex = 0
      const hit = matcher.test(span.textContent ?? '')
      if (hit) span.setAttribute('data-pdf-hit', '')
      else span.removeAttribute('data-pdf-hit')
    }
  }, [query, options, textVersion])

  return (
    <>
      <canvas ref={canvasRef} className="v3-pdf-canvas" aria-hidden />
      <div ref={textRef} className="v3-pdf-text" />
    </>
  )
}

function isPasswordError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'PasswordException' || (error as { code?: unknown }).code === 1
}
