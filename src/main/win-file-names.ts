const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i

export function isWindowsDeviceName(name: string): boolean {
  const base = String(name).trim().replace(/[. ]+$/, '')
  return base ? WINDOWS_DEVICE.test(base) : false
}
