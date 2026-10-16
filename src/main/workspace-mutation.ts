import { resolve } from 'node:path'
const occupied = new Set<string>()
function key(cwd: string): string { const path = resolve(cwd); return process.platform === 'win32' ? path.toLowerCase() : path }
export function workspaceMutationInProgress(cwd: string): boolean { return occupied.has(key(cwd)) }
export function reserveWorkspaceMutation(cwd: string): (() => void) | null {
  const id = key(cwd)
  if (occupied.has(id)) return null
  occupied.add(id)
  let released = false
  return () => { if (!released) { released = true; occupied.delete(id) } }
}
