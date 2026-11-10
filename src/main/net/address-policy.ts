import { isIP } from 'node:net'

const METADATA_ADDRESSES = new Set(['169.254.169.254', '169.254.170.2', '168.63.129.16', '100.100.100.200'])
const METADATA_V6_ADDRESSES = new Set(['fd00:ec2::254'])

export function ipv4Text(ipv4: number): string {
  return `${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`
}

export function embeddedIpv4(value: bigint): string | undefined {
  if (value >> 32n === 0xffffn) return ipv4Text(Number(value & 0xffffffffn))
  if (inIpv6Range(value, 0x0064ff9b000000000000000000000000n, 96)) return ipv4Text(Number(value & 0xffffffffn))
  if (inIpv6Range(value, 0x20020000000000000000000000000000n, 16)) return ipv4Text(Number((value >> 80n) & 0xffffffffn))
  return undefined
}

export function normalizeAddressLiteral(raw: string): string | undefined {
  const address = raw.trim().replace(/^\[|\]$/g, '').split('%', 1)[0]
  const kind = isIP(address)
  if (kind === 4) return address
  if (kind !== 6) return undefined
  const value = parseIpv6Literal(address)
  if (value === null) return undefined
  return embeddedIpv4(value) ?? address.toLowerCase()
}

export function isLinkLocalAddress(raw: string): boolean {
  const address = normalizeAddressLiteral(raw)
  if (!address) return false
  if (isIP(address) === 4) return /^169\.254\./.test(address)
  return /^fe[89ab][0-9a-f]:/.test(address)
}

export function isMetadataAddress(raw: string): boolean {
  const address = normalizeAddressLiteral(raw)
  if (!address) return false
  return isIP(address) === 4 ? METADATA_ADDRESSES.has(address) : METADATA_V6_ADDRESSES.has(address)
}

export function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n)
  return (value & mask) === base
}

export function parseIpv6Literal(raw: string): bigint | null {
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
  const compressed = halves.length === 2
  if (!compressed && left.length !== 8) return null
  const expanded = compressed ? 8 - left.length - right.length : 0
  if (compressed && expanded < 1) return null
  const groups = [...left, ...Array.from({ length: expanded }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return groups.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part, 16)), 0n)
}
