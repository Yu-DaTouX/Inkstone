export function isSessionBundleDrag(data: DataTransfer | null): boolean {
  return !!data && data.types.includes('Files') && [...data.items].some((item) => item.kind === 'file' && item.type === 'application/json')
}
