import { resolve } from 'node:path'

function key(cwd: string): string {
  const path = resolve(cwd).replace(/\\/g, '/')
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

function nested(child: string, parent: string): boolean {
  return parent === '/' ? child.startsWith('/') : child.startsWith(`${parent}/`)
}

export function workspacePathsOverlap(a: string, b: string): boolean {
  const left = key(a)
  const right = key(b)
  if (!left || !right) return false
  if (left === right) return true
  return nested(left, right) || nested(right, left)
}

export function busyWorkspaceOverlap(cwd: string, roots: readonly string[]): boolean {
  return roots.some((root) => workspacePathsOverlap(root, cwd))
}

const occupied = new Set<string>()

export function workspaceMutationInProgress(cwd: string): boolean {
  for (const id of occupied) if (workspacePathsOverlap(id, cwd)) return true
  return false
}

export function reserveWorkspaceMutation(cwd: string): (() => void) | null {
  if (workspaceMutationInProgress(cwd)) return null
  const id = key(cwd)
  occupied.add(id)
  let released = false
  return () => {
    if (released) return
    released = true
    occupied.delete(id)
  }
}
