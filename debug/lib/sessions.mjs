import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { sessionSamplesDir } from './env.mjs'

export const realSessionsDir = join(homedir(), '.pi', 'agent', 'sessions')
const manifestFile = join(sessionSamplesDir, 'manifest.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function jsonlFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const bucket of readdirSync(dir, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    for (const file of readdirSync(join(dir, bucket.name))) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, bucket.name, file)
      out.push({ path, bucket: bucket.name, file, bytes: statSync(path).size })
    }
  }
  return out
}

export function readManifest() {
  if (!existsSync(manifestFile)) return []
  try { return JSON.parse(readFileSync(manifestFile, 'utf8')) } catch { return [] }
}

export function pickSamples({ count = 3, minBytes = 0, bucket } = {}) {
  const manifest = readManifest()
  const known = new Set(manifest.map((entry) => `${entry.bucket}/${entry.file}`))
  const candidates = jsonlFiles(realSessionsDir)
    .filter((entry) => entry.bytes >= minBytes && (!bucket || entry.bucket === bucket))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, count)
  const added = []
  for (const entry of candidates) {
    const key = `${entry.bucket}/${entry.file}`
    if (known.has(key)) continue
    const target = join(sessionSamplesDir, entry.bucket, entry.file)
    mkdirSync(join(sessionSamplesDir, entry.bucket), { recursive: true })
    copyFileSync(entry.path, target)
    const record = { bucket: entry.bucket, file: entry.file, bytes: entry.bytes, sha256: sha256(target), source: entry.path, copiedAt: new Date().toISOString() }
    manifest.push(record)
    added.push(record)
  }
  mkdirSync(sessionSamplesDir, { recursive: true })
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  return { added, total: manifest.length }
}

export function samplePaths(selector) {
  const all = readManifest().map((entry) => ({ ...entry, path: join(sessionSamplesDir, entry.bucket, entry.file) })).filter((entry) => existsSync(entry.path))
  if (!selector || selector === true) return []
  if (selector === 'all') return all
  const wanted = String(selector).split(',').map((part) => part.trim()).filter(Boolean)
  return all.filter((entry, index) => wanted.some((want) => want === String(index + 1) || entry.file.includes(want)))
}

export function describeSamples() {
  return readManifest().map((entry, index) => {
    const path = join(sessionSamplesDir, entry.bucket, entry.file)
    const state = !existsSync(path) ? '缺失' : statSync(path).size !== entry.bytes ? '已变' : '完好'
    return `${String(index + 1).padStart(2)}. ${(entry.bytes / 1e6).toFixed(1).padStart(6)}MB  ${state}  ${relative(sessionSamplesDir, path)}`
  })
}
