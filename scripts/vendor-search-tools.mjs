#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
export const SEARCH_TOOLS_DIR = join(ROOT, 'resources', 'search-tools')

export const SEARCH_TOOL_PINS = {
  'win32-x64': [
    {
      binary: 'rg.exe',
      version: '15.2.0',
      url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip',
      size: 1789611,
      sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'
    },
    {
      binary: 'fd.exe',
      version: '10.5.0',
      url: 'https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip',
      size: 1535063,
      sha256: 'a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7'
    }
  ]
}

const MANIFEST = 'search-tools.json'

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    } else if (entry.toLowerCase() === name.toLowerCase()) return path
  }
  return null
}

export function vendoredUpToDate(pins, dir = SEARCH_TOOLS_DIR) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    return pins.every((pin) => manifest[pin.binary] === pin.sha256 && existsSync(join(dir, pin.binary)))
  } catch {
    return false
  }
}

async function fetchPinned(pin, file) {
  const response = await fetch(pin.url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${pin.url}: HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (data.length !== pin.size || sha256 !== pin.sha256) throw new Error(`${pin.url}: size/sha256 mismatch (${data.length}, ${sha256})`)
  writeFileSync(file, data)
}

async function main() {
  const key = `${process.platform}-${process.arch}`
  const pins = SEARCH_TOOL_PINS[key]
  if (!pins) {
    console.log(`search tools: no pinned binaries for ${key}, skipped`)
    return
  }
  if (vendoredUpToDate(pins)) {
    console.log(`search tools: up to date in ${SEARCH_TOOLS_DIR}`)
    return
  }
  if (process.argv.includes('--check')) {
    console.error('search tools: missing or outdated; run npm run vendor:search-tools')
    process.exit(1)
  }
  const work = mkdtempSync(join(tmpdir(), 'inkstone-search-tools-'))
  try {
    mkdirSync(SEARCH_TOOLS_DIR, { recursive: true })
    const manifest = {}
    for (const pin of pins) {
      const archive = join(work, `${pin.binary}.zip`)
      await fetchPinned(pin, archive)
      const extracted = join(work, pin.binary.replace(/\W/g, '_'))
      mkdirSync(extracted)
      execFileSync('tar', ['-xf', archive, '-C', extracted])
      const found = findFile(extracted, pin.binary)
      if (!found) throw new Error(`${pin.binary} not found in ${pin.url}`)
      copyFileSync(found, join(SEARCH_TOOLS_DIR, pin.binary))
      manifest[pin.binary] = pin.sha256
      console.log(`search tools: ${pin.binary} ${pin.version}`)
    }
    writeFileSync(join(SEARCH_TOOLS_DIR, MANIFEST), JSON.stringify(manifest, null, 2))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('vendor-search-tools.mjs')) {
  await main()
}
