import { isAbsolute, join, resolve } from 'node:path'

export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function evidenceDir(root, topic, now = new Date()) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(topic)) throw new Error(`invalid evidence topic: ${topic}`)
  return join(root, '.local-docs', 'evidence', `${localDay(now)}-${topic}`)
}

export function outputDir(argv, root, topic, now = new Date()) {
  const i = argv.indexOf('--out')
  const value = i >= 0 ? argv[i + 1] : undefined
  if (i >= 0 && (!value || value.startsWith('--'))) throw new Error('--out needs a directory')
  if (value) return isAbsolute(value) ? value : resolve(root, value)
  return evidenceDir(root, topic, now)
}
