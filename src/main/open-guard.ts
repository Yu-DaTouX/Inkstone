import { basename, extname } from 'node:path'

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'appref-ms', 'application',
  'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'msc', 'inf', 'gadget', 'shb', 'shs', 'scf', 'dll', 'ocx', 'sys', 'drv',
  'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1', 'psm1', 'pssc', 'cdxml', 'mof',
  'vb', 'vbs', 'vbe', 'js', 'jse', 'ws', 'wsc', 'wsf', 'wsh', 'sct', 'hta', 'chm', 'hlp',
  'lnk', 'url', 'website', 'library-ms', 'settingcontent-ms', 'searchconnector-ms', 'diagcab', 'xbap', 'xll', 'jnlp',
  'jar', 'reg', 'iso', 'img', 'vhd', 'vhdx',
  'py', 'pyw', 'pyz', 'pyzw', 'pyc', 'pl', 'rb', 'sh', 'bash', 'command', 'tool', 'desktop', 'app', 'run', 'action', 'workflow'
])

function isUnsafeNameChar(code: number): boolean {
  return code < 0x20 || code === 0x7f || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}

function hasUnsafeNameChar(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) if (isUnsafeNameChar(name.charCodeAt(i))) return true
  return false
}

export type OpenBlockReason = 'unsafe-name' | 'alternate-stream' | 'executable'

export function openBlockReason(target: string): OpenBlockReason | null {
  const trimmed = String(target ?? '').trim()
  if (!trimmed || /[\\/]$/.test(trimmed)) return null
  const name = basename(trimmed.replace(/\\/g, '/'))
  if (hasUnsafeNameChar(name)) return 'unsafe-name'
  if (name.includes(':')) return 'alternate-stream'
  const normalized = name.replace(/[. ]+$/, '')
  const ext = extname(normalized).slice(1).toLowerCase()
  return ext.length > 0 && BLOCKED_EXTENSIONS.has(ext) ? 'executable' : null
}

export function openBlockedByExtension(target: string): boolean {
  return openBlockReason(target) !== null
}
