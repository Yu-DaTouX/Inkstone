import { extname, sep } from 'node:path'

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'inf', 'gadget', 'shb', 'scf',
  'ps1', 'ps1xml', 'psc1', 'psd1', 'pssc', 'cdxml', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'lnk', 'url', 'jar', 'reg'
])

export function openBlockedByExtension(target: string): boolean {
  const trimmed = target.trim()
  if (!trimmed || trimmed.endsWith(sep) || /[\\/]$/.test(trimmed)) return false
  const ext = extname(trimmed).slice(1).toLowerCase()
  return ext.length > 0 && BLOCKED_EXTENSIONS.has(ext)
}
