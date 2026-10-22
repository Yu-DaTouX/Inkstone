import type { Lang } from '../../i18n'

export interface PreviewText {
  lang: Lang
  title: string
  empty: string
  emptyHint: string
  loading: string
  failed: string
  binary: string
  binaryHint: string
  imageNote: string
  officeNote: string
  savedNote: string
  truncated: string
  tooManyLines: string
  open: string
  reveal: string
  copyPath: string
  copyPathDone: string
  retry: string
  lineRange: string
  artifacts: string
  notOwner: string
  tabsLabel: string
  closeTab: string
  closeAllTabs: string
  crumbsLabel: string
  readingMode: string
  sourceMode: string
  edit: string
  viewMode: string
  save: string
  saving: string
  saved: string
  dirty: string
  conflict: string
  saveFailed: string
  reload: string
  discard: string
  closeEditor: string
  emptyTitle: string
  emptyTree: string
  emptyNoTree: string
  noSelection: string
  noSelectionHint: string
  missing: string
  missingHint: string
  missingCreatable: string
  directory: string
  unreadable: string
  invalidPath: string
  notFile: string
  outsideRoot: string
  encodingNote: string
  mediaHint: string
  mediaLoadFailed: string
  imageLoadFailedHint: string
  mediaLoadFailedHint: string
  frameFailed: string
  pdfToolbar: string
  pdfPrevPage: string
  pdfNextPage: string
  pdfFitWidth: string
  pdfZoomIn: string
  pdfZoomOut: string
  pdfZoomReset: string
  pdfFailed: string
  pdfFailedHint: string
  pdfPassword: string
  pdfPasswordHint: string
  pdfTooLarge: string
  pdfTooLargeHint: string
  htmlLoading: string
  liveGenerating: string
  canvasMode: string
  singleMode: string
  canvasHint: string
  canvasZoomIn: string
  canvasZoomOut: string
  canvasZoomReset: string
  canvasFit: string
  canvasOpen: string
  canvasRun: string
  canvasStop: string
  canvasDesktop: string
  canvasPhone: string
  canvasAgentEditing: string
  canvasTools: string
  canvasToolHand: string
  canvasToolInteract: string
  canvasToolInspect: string
  canvasDevices: string
  canvasDeviceDesktop: string
  canvasDeviceLaptop: string
  canvasDeviceTablet: string
  canvasDevicePhone: string
  canvasDeviceCustom: string
  canvasCustomWidth: string
  canvasReload: string
  canvasFocusFrame: string
  canvasInspectTitle: string
  canvasInspectPanel: string
  canvasInspectEmpty: string
  canvasInspectCopySelector: string
  canvasInspectCopied: string
  canvasInspectSize: string
  canvasInspectFrameSize: string
  canvasInspectBox: string
  canvasInspectColors: string
  canvasInspectColor: string
  canvasInspectBackground: string
  canvasInspectTypography: string
  canvasInspectFont: string
  canvasInspectFontSize: string
  canvasInspectLineHeight: string
  canvasInspectWeight: string
  canvasInspectLetterSpacing: string
  canvasInspectAlign: string
  canvasInspectSpacing: string
  canvasInspectPadding: string
  canvasInspectMargin: string
  canvasInspectRadius: string
  canvasInspectLayout: string
  canvasInspectDisplay: string
  canvasInspectSource: string
  canvasInspectOffset: string
  canvasDockExpand: string
  canvasDockCollapse: string
  canvasDockPickElement: string
  csvEmpty: string
  csvFailed: string
  csvFailedHint: string
  csvFilterRows: string
  csvRowCount: string
  csvShownRows: string
  csvSortBy: string
  csvTableLabel: string
  csvShowingRows: string
  csvShowingColumns: string
  csvShowingBoth: string
  csvLongCells: string
  csvMissingEnd: string
  revealInTree: string
  keepTab: string
  closeOtherTabs: string
  closeTabsRight: string
  copy: string
  copyAbsolute: string
  copyRelative: string
  copyName: string
  previewTabHint: string
  moreTabs: string
  codeLabel: string
  plainNote: string
  fold: string
  unfold: string
  folded: string
  wordWrap: string
  indentGuides: string
  showWhitespace: string
  scrollPastEnd: string
  tabSize: string
  previewTabs: string
  find: string
  findPlaceholder: string
  findMatchCase: string
  findWholeWord: string
  findRegexp: string
  findPrev: string
  findNext: string
  findClose: string
  findNoResults: string
  findInvalid: string
  findStatus: string
  goToLine: string
  goToPlaceholder: string
  goToInvalid: string
  goToInvalidRange: string
  goToClose: string
  commentOnLine: string
  commentOnLines: string
  commentPlaceholder: string
  commentSave: string
  commentCancel: string
}

const ZH: PreviewText = {
  lang: 'zh-CN',
  title: '预览',
  empty: '没有打开的预览',
  emptyHint: '在文件面板点一个文件，或从成果卡片打开。',
  loading: '正在读取…',
  failed: '无法预览',
  binary: '无法在这里预览这个文件',
  binaryHint: '二进制文件只显示元信息，可用系统程序打开。',
  imageNote: '图片经主进程校验后以只读地址显示。',
  officeNote: '正文由宿主从文件提取，版式以原文件为准。',
  savedNote: '这里只是只读预览，不修改原文件。',
  truncated: '文件较大，只显示前面一部分。',
  tooManyLines: '内容太多，只渲染前 {n} 行。',
  open: '用系统程序打开',
  reveal: '在文件夹中显示',
  copyPath: '复制路径',
  copyPathDone: '已复制',
  retry: '重试',
  lineRange: '第 {start}–{end} 行',
  artifacts: '这条会话的成果',
  notOwner: '该会话不是当前活动会话；激活后即可查看它的成果。',
  tabsLabel: '打开的文件',
  closeTab: '关闭',
  closeAllTabs: '关闭全部',
  crumbsLabel: '文件路径',
  readingMode: '阅读模式',
  sourceMode: '查看源码',
  edit: '编辑',
  viewMode: '回到预览',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存',
  dirty: '已修改，未保存',
  conflict: '文件已被外部改动，未覆盖',
  saveFailed: '保存失败',
  reload: '重新加载',
  discard: '放弃改动',
  closeEditor: '关闭编辑',
  emptyTitle: '打开的文件会显示在这里',
  emptyTree: '从文件树中选择一个文件，或点击对话中的文件路径。',
  emptyNoTree: '点击对话中的文件路径即可打开。',
  noSelection: '未选择文件',
  noSelectionHint: '从上方选择一个已打开的文件，或点击对话中的文件路径。',
  missing: '文件不存在',
  missingHint: '它可能已被移动或删除。',
  missingCreatable: '所在文件夹存在，这个文件还没有创建。',
  directory: '这是一个文件夹',
  unreadable: '无法读取此文件（可能没有权限）',
  invalidPath: '路径无效',
  notFile: '不是普通文件',
  outsideRoot: '此文件在工作目录之外。',
  encodingNote: '无法识别文本编码，内容可能显示为乱码。',
  mediaHint: '音视频与 PDF 请用系统程序打开。',
  mediaLoadFailed: '无法加载这个文件',
  imageLoadFailedHint: '这张图片没能加载，可能太大，或者已被移动、删除。',
  mediaLoadFailedHint: '这个文件无法在这里播放：可能是格式不支持、文件太大，或者已被移动、删除。',
  frameFailed: '这个文件没能渲染出来',
  pdfToolbar: 'PDF 工具栏',
  pdfPrevPage: '上一页',
  pdfNextPage: '下一页',
  pdfFitWidth: '适合宽度',
  pdfZoomIn: '放大',
  pdfZoomOut: '缩小',
  pdfZoomReset: '缩放回 100%',
  pdfFailed: '无法显示这个 PDF',
  pdfFailedHint: '文件可能已损坏，或者格式不受支持。可以用系统程序打开，或者重试。',
  pdfPassword: '这个 PDF 已加密',
  pdfPasswordHint: '需要密码才能显示内容。可以用系统程序打开，输入密码后查看。',
  pdfTooLarge: '这个 PDF 太大',
  pdfTooLargeHint: '超过 64 MB 的 PDF 不在这里渲染，可以用系统程序打开。',
  htmlLoading: '正在加载预览…',
  liveGenerating: '正在生成…',
  canvasMode: '画布视图',
  singleMode: '单页视图',
  canvasHint: '画布：拖动平移，Ctrl+滚轮缩放，双击画框标题缩放到该画框，按 0 适配',
  canvasZoomIn: '放大',
  canvasZoomOut: '缩小',
  canvasZoomReset: '缩放到 100%',
  canvasFit: '适配画布',
  canvasOpen: '用默认程序打开',
  canvasRun: '运行（可交互）',
  canvasStop: '停止交互',
  canvasDesktop: '桌面',
  canvasPhone: '手机',
  canvasAgentEditing: 'Agent 正在编辑',
  canvasTools: '画布工具',
  canvasToolHand: '移动画布',
  canvasToolInteract: '操作页面',
  canvasToolInspect: '检查元素',
  canvasDevices: '画框设备',
  canvasDeviceDesktop: '桌面',
  canvasDeviceLaptop: '笔记本',
  canvasDeviceTablet: '平板',
  canvasDevicePhone: '手机',
  canvasDeviceCustom: '自定义宽度',
  canvasCustomWidth: '宽度（px）',
  canvasReload: '刷新画框',
  canvasFocusFrame: '双击缩放到这个画框',
  canvasInspectTitle: '检查',
  canvasInspectPanel: '元素属性',
  canvasInspectEmpty: '把指针移到画框里的元素上，点击即可查看属性。',
  canvasInspectCopySelector: '复制选择器',
  canvasInspectCopied: '已复制',
  canvasInspectSize: '尺寸',
  canvasInspectFrameSize: '外框',
  canvasInspectBox: '盒子（宽 / 高）',
  canvasInspectColors: '颜色',
  canvasInspectColor: '文字',
  canvasInspectBackground: '背景',
  canvasInspectTypography: '字体',
  canvasInspectFont: '字体族',
  canvasInspectFontSize: '字号',
  canvasInspectLineHeight: '行高',
  canvasInspectWeight: '字重',
  canvasInspectLetterSpacing: '字距',
  canvasInspectAlign: '对齐',
  canvasInspectSpacing: '间距',
  canvasInspectPadding: '内边距',
  canvasInspectMargin: '外边距',
  canvasInspectRadius: '圆角',
  canvasInspectLayout: '布局',
  canvasInspectDisplay: '显示',
  canvasInspectSource: '源码',
  canvasInspectOffset: '偏移',
  canvasDockExpand: '展开面板',
  canvasDockCollapse: '收起面板',
  canvasDockPickElement: '点选画框里的元素',
  csvEmpty: '这个文件是空的',
  csvFailed: '无法把这个文件解析成表格',
  csvFailedHint: '切换到源码可以看原始文本。',
  csvFilterRows: '筛选行',
  csvRowCount: '{n} 行',
  csvShownRows: '{shown} / {total} 行',
  csvSortBy: '按「{column}」排序',
  csvTableLabel: '表格预览',
  csvShowingRows: '只显示前 {rows} 行。{cells}切换到源码查看全部。',
  csvShowingColumns: '只显示前 {cols} 列。{cells}切换到源码查看全部。',
  csvShowingBoth: '只显示前 {rows} 行、前 {cols} 列。{cells}切换到源码查看全部。',
  csvLongCells: '过长的单元格已截短。',
  csvMissingEnd: '预览可能缺少文件结尾。',
  revealInTree: '在文件树中显示',
  keepTab: '保持打开',
  closeOtherTabs: '关闭其他',
  closeTabsRight: '关闭右侧',
  copy: '复制',
  copyAbsolute: '绝对路径',
  copyRelative: '相对路径',
  copyName: '文件名',
  previewTabHint: '预览',
  moreTabs: '更多文件',
  codeLabel: '文件内容',
  plainNote: '文件较大，按纯文本显示，不做语法着色。',
  fold: '折叠',
  unfold: '展开',
  folded: '⋯',
  wordWrap: '自动换行',
  indentGuides: '缩进参考线',
  showWhitespace: '显示空白字符',
  scrollPastEnd: '可滚动到末行之后',
  tabSize: 'Tab 宽度 {n}',
  previewTabs: '预览标签',
  find: '在文件中查找',
  findPlaceholder: '查找…',
  findMatchCase: '区分大小写',
  findWholeWord: '全词匹配',
  findRegexp: '使用正则表达式',
  findPrev: '上一个匹配',
  findNext: '下一个匹配',
  findClose: '关闭查找',
  findNoResults: '没有匹配',
  findInvalid: '正则表达式无效',
  findStatus: '{current} / {total}',
  goToLine: '跳转到行',
  goToPlaceholder: '行号，或 行:列',
  goToInvalid: '输入 1–{lines} 之间的行号',
  goToInvalidRange: '输入第 {first}–{last} 行之间的行号',
  goToClose: '关闭跳转',
  commentOnLine: '评论第 {line} 行',
  commentOnLines: '评论第 {start}–{end} 行',
  commentPlaceholder: '写下评论，回车加入输入框',
  commentSave: '加入输入框',
  commentCancel: '取消评论'
}

const EN: PreviewText = {
  lang: 'en-US',
  title: 'Preview',
  empty: 'Nothing to preview',
  emptyHint: 'Pick a file in the Files panel, or open one from an artifact card.',
  loading: 'Reading…',
  failed: 'Cannot preview',
  binary: 'This file cannot be previewed here',
  binaryHint: 'Binary files show metadata only; open them with a system app.',
  imageNote: 'The image is shown from a read-only address validated by the host.',
  officeNote: 'Text is extracted by the host; the original file owns the layout.',
  savedNote: 'This is a read-only preview; the original file is not modified.',
  truncated: 'Large file — only the beginning is shown.',
  tooManyLines: 'Too much content — rendering the first {n} lines only.',
  open: 'Open in system app',
  reveal: 'Show in folder',
  copyPath: 'Copy path',
  copyPathDone: 'Copied',
  retry: 'Retry',
  lineRange: 'Lines {start}–{end}',
  artifacts: 'Artifacts from this chat',
  notOwner: 'This chat is not the active one; activate it to see its artifacts.',
  tabsLabel: 'Open files',
  closeTab: 'Close',
  closeAllTabs: 'Close all',
  crumbsLabel: 'File path',
  readingMode: 'Reading view',
  sourceMode: 'View source',
  edit: 'Edit',
  viewMode: 'Back to preview',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  dirty: 'Unsaved changes',
  conflict: 'File changed on disk; not overwritten',
  saveFailed: 'Could not save',
  reload: 'Reload',
  discard: 'Discard changes',
  closeEditor: 'Close editor',
  emptyTitle: 'Open files appear here',
  emptyTree: 'Pick a file in the tree, or click a file path in the conversation.',
  emptyNoTree: 'Click a file path in the conversation to open it.',
  noSelection: 'No file selected',
  noSelectionHint: 'Pick an open file above, or click a file path in the conversation.',
  missing: 'File not found',
  missingHint: 'It may have been moved or deleted.',
  missingCreatable: 'The folder exists; this file has not been created yet.',
  directory: 'This is a folder',
  unreadable: 'Couldn’t read this file (permission may be missing)',
  invalidPath: 'Invalid path',
  notFile: 'Not a regular file',
  outsideRoot: 'This file is outside the working directory.',
  encodingNote: 'The text encoding was not recognized; content may look garbled.',
  mediaHint: 'Open audio, video and PDF files with a system app.',
  mediaLoadFailed: 'Couldn’t load this file',
  imageLoadFailedHint: 'This image couldn’t be loaded. It may be too large, or it may have been deleted or moved.',
  mediaLoadFailedHint: 'This file couldn’t be previewed. The format may not be supported, it may be too large, or it may have been deleted or moved.',
  frameFailed: 'This file didn’t render',
  pdfToolbar: 'PDF toolbar',
  pdfPrevPage: 'Previous page',
  pdfNextPage: 'Next page',
  pdfFitWidth: 'Fit width',
  pdfZoomIn: 'Zoom in',
  pdfZoomOut: 'Zoom out',
  pdfZoomReset: 'Reset zoom to 100%',
  pdfFailed: 'Couldn’t display this PDF',
  pdfFailedHint: 'The file may be damaged or in an unsupported format. Open it with a system app, or try again.',
  pdfPassword: 'This PDF is encrypted',
  pdfPasswordHint: 'A password is needed to show it. Open it with a system app to enter the password.',
  pdfTooLarge: 'This PDF is too large',
  pdfTooLargeHint: 'PDFs over 64 MB are not rendered here; open it with a system app.',
  htmlLoading: 'Loading preview…',
  liveGenerating: 'Generating…',
  canvasMode: 'Canvas view',
  singleMode: 'Single page view',
  canvasHint: 'Canvas: drag to pan, Ctrl+wheel to zoom, double-click a frame title to zoom into it, 0 to fit',
  canvasZoomIn: 'Zoom in',
  canvasZoomOut: 'Zoom out',
  canvasZoomReset: 'Zoom to 100%',
  canvasFit: 'Fit canvas',
  canvasOpen: 'Open with default app',
  canvasRun: 'Run (interactive)',
  canvasStop: 'Stop interacting',
  canvasDesktop: 'Desktop',
  canvasPhone: 'Phone',
  canvasAgentEditing: 'Agent is editing',
  canvasTools: 'Canvas tools',
  canvasToolHand: 'Pan canvas',
  canvasToolInteract: 'Interact with page',
  canvasToolInspect: 'Inspect element',
  canvasDevices: 'Frame devices',
  canvasDeviceDesktop: 'Desktop',
  canvasDeviceLaptop: 'Laptop',
  canvasDeviceTablet: 'Tablet',
  canvasDevicePhone: 'Phone',
  canvasDeviceCustom: 'Custom width',
  canvasCustomWidth: 'Width (px)',
  canvasReload: 'Reload frame',
  canvasFocusFrame: 'Double-click to zoom to this frame',
  canvasInspectTitle: 'Inspect',
  canvasInspectPanel: 'Element properties',
  canvasInspectEmpty: 'Hover an element inside a frame and click to inspect it.',
  canvasInspectCopySelector: 'Copy selector',
  canvasInspectCopied: 'Copied',
  canvasInspectSize: 'Size',
  canvasInspectFrameSize: 'Frame',
  canvasInspectBox: 'Box (width / height)',
  canvasInspectColors: 'Colors',
  canvasInspectColor: 'Text',
  canvasInspectBackground: 'Background',
  canvasInspectTypography: 'Typography',
  canvasInspectFont: 'Font',
  canvasInspectFontSize: 'Font size',
  canvasInspectLineHeight: 'Line height',
  canvasInspectWeight: 'Weight',
  canvasInspectLetterSpacing: 'Letter spacing',
  canvasInspectAlign: 'Align',
  canvasInspectSpacing: 'Spacing',
  canvasInspectPadding: 'Padding',
  canvasInspectMargin: 'Margin',
  canvasInspectRadius: 'Radius',
  canvasInspectLayout: 'Layout',
  canvasInspectDisplay: 'Display',
  canvasInspectSource: 'Source',
  canvasInspectOffset: 'Offset',
  canvasDockExpand: 'Expand panel',
  canvasDockCollapse: 'Collapse panel',
  canvasDockPickElement: 'Pick an element in a frame',
  csvEmpty: 'This file is empty',
  csvFailed: 'Couldn’t parse this file as a table',
  csvFailedHint: 'Switch to the source to see the raw text.',
  csvFilterRows: 'Filter rows',
  csvRowCount: '{n} rows',
  csvShownRows: '{shown} / {total} rows',
  csvSortBy: 'Sort by {column}',
  csvTableLabel: 'Table preview',
  csvShowingRows: 'Showing the first {rows} rows.{cells} Switch to the source to see more.',
  csvShowingColumns: 'Showing the first {cols} columns.{cells} Switch to the source to see more.',
  csvShowingBoth: 'Showing the first {rows} rows and {cols} columns.{cells} Switch to the source to see more.',
  csvLongCells: ' Long cells are shortened.',
  csvMissingEnd: 'This preview may be missing its end.',
  revealInTree: 'Reveal in file tree',
  keepTab: 'Keep open',
  closeOtherTabs: 'Close others',
  closeTabsRight: 'Close to the right',
  copy: 'Copy',
  copyAbsolute: 'Absolute path',
  copyRelative: 'Relative path',
  copyName: 'File name',
  previewTabHint: 'preview',
  moreTabs: 'More files',
  codeLabel: 'File contents',
  plainNote: 'Large file: shown as plain text without syntax colors.',
  fold: 'Fold',
  unfold: 'Unfold',
  folded: '⋯',
  wordWrap: 'Word wrap',
  indentGuides: 'Indent guides',
  showWhitespace: 'Show whitespace',
  scrollPastEnd: 'Scroll past last line',
  tabSize: 'Tab size {n}',
  previewTabs: 'Preview tabs',
  find: 'Find in file',
  findPlaceholder: 'Find…',
  findMatchCase: 'Match case',
  findWholeWord: 'Match whole word',
  findRegexp: 'Use regular expression',
  findPrev: 'Previous match',
  findNext: 'Next match',
  findClose: 'Close find bar',
  findNoResults: 'No results',
  findInvalid: 'Invalid regular expression',
  findStatus: '{current} / {total}',
  goToLine: 'Go to line',
  goToPlaceholder: 'Line, or line:column',
  goToInvalid: 'Type a line number from 1 to {lines}',
  goToInvalidRange: 'Type a line number from {first} to {last}',
  goToClose: 'Close go to line bar',
  commentOnLine: 'Comment on line {line}',
  commentOnLines: 'Comment on lines {start}–{end}',
  commentPlaceholder: 'Add a comment; Enter adds it to the composer',
  commentSave: 'Add to prompt',
  commentCancel: 'Cancel comment'
}

export function previewText(lang: Lang): PreviewText {
  return lang === 'en-US' ? EN : ZH
}
