import { createHash } from 'node:crypto'

export function legacyProjectId(cwd: string): string {
  return `project-${Buffer.from(cwd.toLowerCase()).toString('base64url').slice(0, 36)}`
}

export function hashedProjectId(cwd: string): string {
  return `project-${createHash('sha1').update(cwd.toLowerCase()).digest('base64url').slice(0, 36)}`
}

export function projectIdForCwd(cwd: string, isTaken?: (id: string) => boolean): string {
  const legacy = legacyProjectId(cwd)
  if (!isTaken || !isTaken(legacy)) return legacy
  let id = hashedProjectId(cwd)
  let salt = 0
  while (isTaken(id)) id = hashedProjectId(`${cwd}\u0000${salt++}`)
  return id
}
