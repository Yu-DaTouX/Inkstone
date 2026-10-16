export interface DiffViewText {
  unified: string
  split: string
  prevHunk: string
  nextHunk: string
  hunkOf: (index: number, total: number) => string
  expandLines: (count: number) => string
  binaryFile: string
  tooLarge: (size: string) => string
  renderAnyway: string
  empty: string
  fileHeader: string
}

export function diffViewText(lang: string): DiffViewText {
  if (String(lang).toLowerCase().startsWith('en')) {
    return {
      unified: 'Unified',
      split: 'Side by side',
      prevHunk: 'Previous change',
      nextHunk: 'Next change',
      hunkOf: (index, total) => `Change ${index} / ${total}`,
      expandLines: (count) => `Show ${count} unchanged line${count === 1 ? '' : 's'}`,
      binaryFile: 'Binary file — not shown as text',
      tooLarge: (size) => `Patch is ${size}; content rendering is disabled`,
      renderAnyway: 'Render anyway',
      empty: 'No changes to show',
      fileHeader: 'File'
    }
  }
  return {
    unified: '统一',
    split: '并排',
    prevHunk: '上一处改动',
    nextHunk: '下一处改动',
    hunkOf: (index, total) => `第 ${index} / ${total} 处改动`,
    expandLines: (count) => `展开 ${count} 行未改动`,
    binaryFile: '二进制文件，无法按文本显示',
    tooLarge: (size) => `补丁约 ${size}，已停用正文渲染`,
    renderAnyway: '仍然渲染',
    empty: '没有可显示的改动',
    fileHeader: '文件'
  }
}
