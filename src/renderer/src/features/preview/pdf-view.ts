export const PDF_ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
export const PDF_ZOOM_MIN = 0.1
export const PDF_ZOOM_MAX = 4
export const PDF_FIT_MIN = 0.1
export const PDF_PAGE_GAP = 16
export const PDF_PAGE_PADDING = 24
export const PDF_LAZY_MARGIN = 600

export interface PdfPageWindow {
  first: number
  last: number
}

export function pdfClampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, value))
}

export function pdfZoomStep(current: number, direction: -1 | 1): number {
  const value = pdfClampZoom(current)
  if (direction < 0) {
    let next = PDF_ZOOM_MIN
    for (const step of PDF_ZOOM_STEPS) {
      if (step < value - 1e-6) next = step
      else break
    }
    return next
  }
  for (const step of PDF_ZOOM_STEPS) {
    if (step > value + 1e-6) return step
  }
  return PDF_ZOOM_MAX
}

export function pdfFitWidthScale(availableWidth: number, pageWidth: number): number {
  if (!(availableWidth > 0) || !(pageWidth > 0)) return 1
  return Math.max(PDF_FIT_MIN, Math.min(PDF_ZOOM_MAX, availableWidth / pageWidth))
}

export function pdfPageTops(heights: readonly number[], gap = PDF_PAGE_GAP, offset = 0): number[] {
  const tops: number[] = []
  let top = offset
  for (const height of heights) {
    tops.push(top)
    top += Math.max(0, height) + gap
  }
  return tops
}

export function pdfPageWindow(
  tops: readonly number[],
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  margin = PDF_LAZY_MARGIN
): PdfPageWindow {
  if (!tops.length) return { first: 0, last: -1 }
  const top = Math.max(0, scrollTop) - margin
  const bottom = Math.max(0, scrollTop) + Math.max(0, viewportHeight) + margin
  let first = -1
  let last = -1
  for (let index = 0; index < tops.length; index += 1) {
    const pageTop = tops[index]
    const pageBottom = pageTop + Math.max(0, heights[index] ?? 0)
    if (pageBottom >= top && pageTop <= bottom) {
      if (first < 0) first = index
      last = index
    }
  }
  if (first < 0) {
    const fallback = tops.length - 1
    return scrollTop <= 0 ? { first: 0, last: Math.min(fallback, 0) } : { first: fallback, last: fallback }
  }
  return { first, last }
}

export function pdfCurrentPage(tops: readonly number[], scrollTop: number): number {
  if (!tops.length) return 0
  const at = Math.max(0, scrollTop) + 1
  let page = 0
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index] <= at) page = index
    else break
  }
  return page
}

export function pdfScaledHeights(
  sizes: readonly { width: number; height: number }[],
  count: number,
  scale: number
): number[] {
  const fallback = sizes[0]
  const heights: number[] = []
  for (let index = 0; index < count; index += 1) {
    const size = sizes[index] ?? fallback
    heights.push(size ? size.height * scale : 0)
  }
  return heights
}
