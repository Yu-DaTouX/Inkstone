const DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'log', 'json', 'csv', 'pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])
export function canOpenDocument(path: string): boolean {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return !!extension && DOCUMENT_EXTENSIONS.has(extension)
}
