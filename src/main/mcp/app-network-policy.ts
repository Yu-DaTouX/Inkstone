import { lookup } from 'node:dns/promises'
import { BlockList } from 'node:net'

const blockedIpv4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blockedIpv4.addSubnet(address, prefix)

const publicIpv6 = new BlockList()
publicIpv6.addSubnet('2000::', 3, 'ipv6')
const blockedIpv6 = new BlockList()
blockedIpv6.addSubnet('2001::', 32, 'ipv6')
blockedIpv6.addSubnet('2001:db8::', 32, 'ipv6')
blockedIpv6.addSubnet('2002::', 16, 'ipv6')

export function isMcpAppPrivateAddress(address: string, family: number): boolean {
  if (family === 4) return blockedIpv4.check(address, 'ipv4')
  if (family === 6) return !publicIpv6.check(address, 'ipv6') || blockedIpv6.check(address, 'ipv6')
  return true
}

export async function isMcpAppPrivateHost(hostname: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answers = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('MCP App DNS timeout')), 5000) })
    ])
    return !answers.length || answers.some(({ address, family }) => isMcpAppPrivateAddress(address, family))
  } catch {
    return true
  } finally { if (timer) clearTimeout(timer) }
}
