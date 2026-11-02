import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export function linkOrCopy(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  try {
    linkSync(source, target)
    return 'link'
  } catch {
    copyFileSync(source, target)
    return 'copy'
  }
}

export function mirrorFile(source, target) {
  const want = statSync(source)
  if (existsSync(target)) {
    const have = statSync(target)
    if (have.size === want.size && Math.abs(have.mtimeMs - want.mtimeMs) < 2) return false
    unlinkSync(target)
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  utimesSync(target, want.atime, want.mtime)
  return true
}

function filesUnder(root, dir = root) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(root, path))
    else if (entry.isFile()) out.push(relative(root, path))
  }
  return out
}

export function mirrorTree(source, target) {
  const wanted = new Set(filesUnder(source))
  for (const file of wanted) mirrorFile(join(source, file), join(target, file))
  for (const file of filesUnder(target)) if (!wanted.has(file)) rmSync(join(target, file), { force: true })
}

export function linkTree(source, target) {
  for (const file of filesUnder(source)) linkOrCopy(join(source, file), join(target, file))
}

export function pruneFiles(root, keep, olderThanMs) {
  for (const file of filesUnder(root)) {
    if (keep.has(file)) continue
    const path = join(root, file)
    if (statSync(path).mtimeMs < olderThanMs) rmSync(path, { force: true })
  }
}
