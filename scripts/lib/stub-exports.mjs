import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']

function resolveModule(from, spec) {
  const base = resolve(dirname(from), spec)
  for (const ext of EXTENSIONS) {
    const candidate = base + ext
    if (existsSync(candidate) && /\.[tj]sx?$/.test(candidate)) return candidate
  }
  return null
}

export function exportedValueNames(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const src = readFileSync(file, 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    if (m[1]) continue
    for (const part of m[2].split(',')) {
      const piece = part.trim()
      if (!piece || /^type\s/.test(piece)) continue
      const alias = piece.split(/\s+as\s+/).pop().trim()
      if (alias) names.add(alias)
    }
  }
  for (const m of src.matchAll(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm)) {
    const target = resolveModule(file, m[1])
    if (target) for (const name of exportedValueNames(target, seen)) names.add(name)
  }
  names.delete('default')
  return [...names]
}

export function fillMissingExports(realFile, stubSource) {
  let out = stubSource
  for (const name of exportedValueNames(realFile)) {
    const declared = new RegExp(String.raw`export\s+(?:async\s+)?(?:function|const|let|var|class)\s+${name}\b`).test(out)
    const listed = new RegExp(String.raw`export\s*\{[^}]*\b${name}\b`).test(out)
    if (declared || listed) continue
    out += `\nexport function ${name}(p){ return p && p.children !== undefined ? p.children : null }`
  }
  return out
}
