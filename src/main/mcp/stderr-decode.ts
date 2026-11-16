import { execFileSync } from 'node:child_process'

const OEM_ENCODINGS: Record<number, string> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  54936: 'gb18030'
}

let cachedOemCodePage: number | null | undefined

export function parseOemCodePage(regOutput: string): number | null {
  const match = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(regOutput)
  return match ? Number(match[1]) : null
}

export function systemOemCodePage(): number | null {
  if (cachedOemCodePage !== undefined) return cachedOemCodePage
  cachedOemCodePage = null
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      cachedOemCodePage = parseOemCodePage(out)
    } catch {
      cachedOemCodePage = null
    }
  }
  return cachedOemCodePage
}

export function resetOemCodePageCache(): void {
  cachedOemCodePage = undefined
}

function legacyDecoder(codePage: number | null): { decode(input: Uint8Array): string } | null {
  const label = codePage ? OEM_ENCODINGS[codePage] : undefined
  if (!label) return null
  try {
    return new TextDecoder(label)
  } catch {
    return null
  }
}

export function decodeProcessOutput(bytes: Buffer, truncatedHead = false, codePage: () => number | null = systemOemCodePage): string {
  let view = bytes
  if (truncatedHead) {
    let skip = 0
    while (skip < 3 && skip < view.length && (view[skip]! & 0xc0) === 0x80) skip += 1
    view = view.subarray(skip)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view)
  } catch {
    const legacy = legacyDecoder(codePage())
    return legacy ? legacy.decode(view) : view.toString('utf8')
  }
}
