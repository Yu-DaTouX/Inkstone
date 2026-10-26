import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const SAMPLE_BYTES = 64 * 1024

export function detectLineEnding(text) {
  const lf = text.indexOf('\n')
  if (lf === -1) return undefined
  return lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n'
}

export function withLineEnding(text, ending) {
  const lf = text.replace(/\r\n/g, '\n')
  return ending === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

function resolveTarget(path, cwd) {
  let target = String(path ?? '').trim()
  if (!target) return undefined
  if (target.startsWith('@')) target = target.slice(1)
  if (target === '~') target = homedir()
  else if (target.startsWith('~/') || target.startsWith('~\\')) target = join(homedir(), target.slice(2))
  return isAbsolute(target) ? target : resolve(cwd || process.cwd(), target)
}

function readSample(file) {
  let fd
  try {
    if (!statSync(file).isFile()) return undefined
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(SAMPLE_BYTES)
    const length = readSync(fd, buffer, 0, SAMPLE_BYTES, 0)
    const sample = buffer.subarray(0, length)
    return sample.includes(0) ? undefined : sample.toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function matchExistingLineEnding(input, cwd) {
  const content = input?.content
  if (typeof content !== 'string' || !content.includes('\n')) return false
  const file = resolveTarget(input.path, cwd)
  const sample = file ? readSample(file) : undefined
  const ending = sample === undefined ? undefined : detectLineEnding(sample)
  if (!ending) return false
  const next = withLineEnding(content, ending)
  if (next === content) return false
  input.content = next
  return true
}

export function registerWriteLineEndings(pi) {
  pi.on('tool_call', (event, ctx) => {
    if (String(event?.toolName ?? '') === 'write') matchExistingLineEnding(event?.input, ctx?.cwd)
    return undefined
  })
}
