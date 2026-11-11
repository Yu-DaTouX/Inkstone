const INTERNAL_TYPES = ['application/x-yan-file-path', 'application/x-yan-file-paths']

export function acceptsFileDrop(data: DataTransfer | null): data is DataTransfer {
  return !!data && (data.types.includes('Files') || INTERNAL_TYPES.some((type) => data.types.includes(type)))
}
