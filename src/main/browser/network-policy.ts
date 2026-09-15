import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * 浏览器网络边界用的地址判断。
 *
 * 这里只判断“不能被远程页面借道访问”的地址范围，不把普通公网地址
 * 猜成安全/不安全。域名会在请求发生时重新 lookup，避免只看 URL 主机名
 * 而漏掉 DNS rebinding 把同一域名切到内网地址的情况。
 */
export function isPrivateAddress(raw: string): boolean {
  const address = raw.trim().replace(/^\[|\]$/g, '').split('%', 1)[0]
  const kind = isIP(address)
  if (kind === 4) return isPrivateIpv4(address)
  if (kind !== 6) return false

  const value = parseIpv6(address)
  if (value === null) return false
  const mapped = value >> 32n
  if (mapped === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn)
    return isPrivateIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`)
  }

  // Unspecified, loopback, IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return value === 0n || value === 1n || inRange(value, 0xfc000000000000000000000000000000n, 7) ||
    inRange(value, 0xfe800000000000000000000000000000n, 10)
}

/**
 * Resolve a host at request time and report whether any returned address is
 * private. An empty/failed lookup is not classified as private here: Chromium
 * will still fail the request itself, while a transient resolver failure must
 * not turn every public page into a permanent deny.
 */
export async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  const value = hostname.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isPrivateAddress(value)) return true
  if (!value || isIP(value)) return false
  try {
    const records = await lookup(value, { all: true, verbatim: true })
    return records.some((record) => isPrivateAddress(record.address))
  } catch {
    return false
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function inRange(value: bigint, base: bigint, prefix: number): boolean {
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n)
  return (value & mask) === base
}

function parseIpv6(raw: string): bigint | null {
  let value = raw.toLowerCase()
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':')
    if (separator < 0) return null
    const ipv4 = value.slice(separator + 1)
    const octets = ipv4.split('.').map((part) => Number(part))
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    value = `${value.slice(0, separator)}:${high}:${low}`
  }
  if (value.includes(':::') || value.split(':').length > 8) return null
  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const expanded = halves.length === 2 ? 8 - left.length - right.length : 0
  if (halves.length === 1 && left.length !== 8) return null
  if (expanded < 1) return null
  const groups = [...left, ...Array.from({ length: expanded }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return groups.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part, 16)), 0n)
}
