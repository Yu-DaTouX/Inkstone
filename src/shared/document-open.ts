/** 外部默认应用只能直接打开文档/被动图片；代码、快捷方式与未知类型只定位。 */
const DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'log', 'json', 'csv', 'pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])
export function canOpenDocument(path: string): boolean {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return !!extension && DOCUMENT_EXTENSIONS.has(extension)
}
