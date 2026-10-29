export interface DiffViewText {
  unified: string
  split: string
  layout: string
  prevHunk: string
  nextHunk: string
  hunkOf: (index: number, total: number) => string
  binaryFile: string
  tooLarge: (size: string) => string
  renderAnyway: string
  empty: string
  fileHeader: string
  preparing: string
  rawFallback: string
}

export function diffViewText(lang: string): DiffViewText {
  if (String(lang).toLowerCase().startsWith('en')) {
    return {
      unified: 'Unified',
      split: 'Side by side',
      layout: 'Diff layout',
      prevHunk: 'Previous change',
      nextHunk: 'Next change',
      hunkOf: (index, total) => `Change ${index} / ${total}`,
      binaryFile: 'Binary file — not shown as text',
      tooLarge: (size) => `Patch is ${size}; content rendering is disabled`,
      renderAnyway: 'Render anyway',
      empty: 'No changes to show',
      fileHeader: 'File',
      preparing: 'Preparing diff…',
      rawFallback: 'This patch could not be parsed; showing it as plain text.'
    }
  }
  return {
    unified: '统一',
    split: '并排',
    layout: 'diff 布局',
    prevHunk: '上一处改动',
    nextHunk: '下一处改动',
    hunkOf: (index, total) => `第 ${index} / ${total} 处改动`,
    binaryFile: '二进制文件，无法按文本显示',
    tooLarge: (size) => `补丁约 ${size}，已停用正文渲染`,
    renderAnyway: '仍然渲染',
    empty: '没有可显示的改动',
    fileHeader: '文件',
    preparing: '正在准备 diff…',
    rawFallback: '无法解析这个补丁，按原文显示。'
  }
}
