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
  keysLabel: (title: string) => string
  keysHelp: string
  keyLine: (kind: 'context' | 'addition' | 'deletion', line: number, code: string) => string
  keyRange: (start: number, end: number, count: number) => string
  annotateKeys: string
  unmodified: (count: number) => string
  moreContext: string
  expandUp: string
  expandDown: string
  expandBoth: (count: number) => string
  expandAll: string
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
      rawFallback: 'This patch could not be parsed; showing it as plain text.',
      keysLabel: (title) => (title ? `Diff of ${title}` : 'Diff'),
      keysHelp: 'Up and down arrows move between lines, Shift extends the selection, Enter comments, Escape clears.',
      keyLine: (kind, line, code) =>
        `${kind === 'addition' ? 'Added' : kind === 'deletion' ? 'Removed' : 'Unchanged'} line ${line}: ${code || 'blank'}`,
      keyRange: (start, end, count) => `Lines ${start}–${end} selected, ${count} lines`,
      annotateKeys: 'Enter to send · Shift+Enter for a new line · Esc to cancel',
      unmodified: (count) => `${count} unchanged ${count === 1 ? 'line' : 'lines'}`,
      moreContext: 'Show more unchanged lines',
      expandUp: 'Expand unchanged lines above',
      expandDown: 'Expand unchanged lines below',
      expandBoth: (count) => `Expand ${count} unchanged ${count === 1 ? 'line' : 'lines'}`,
      expandAll: 'Expand all'
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
    rawFallback: '无法解析这个补丁，按原文显示。',
    keysLabel: (title) => (title ? `${title} 的改动` : '改动'),
    keysHelp: '上下方向键逐行移动，Shift 加方向键扩选，Enter 批注，Esc 清除选择。',
    keyLine: (kind, line, code) =>
      `${kind === 'addition' ? '新增' : kind === 'deletion' ? '删除' : '未改动'} 第 ${line} 行：${code || '空行'}`,
    keyRange: (start, end, count) => `已选第 ${start}–${end} 行，共 ${count} 行`,
    annotateKeys: 'Enter 发送 · Shift+Enter 换行 · Esc 取消',
    unmodified: (count) => `${count} 行未改动`,
    moreContext: '显示更多未改动行',
    expandUp: '向上展开未改动行',
    expandDown: '向下展开未改动行',
    expandBoth: (count) => `展开 ${count} 行未改动`,
    expandAll: '全部展开'
  }
}
