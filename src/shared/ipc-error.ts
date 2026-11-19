const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*(Error:\s*)?/

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function stripIpcErrorPrefix(raw: string): string {
  return raw.replace(IPC_ERROR_PREFIX, '')
}
