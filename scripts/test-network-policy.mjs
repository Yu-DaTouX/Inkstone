export async function runNetworkPolicyTests(ok, policy) {
  const { isPrivateAddress, resolvesToPrivateAddress } = policy
  ok(isPrivateAddress('127.0.0.1'), '网络边界识别 IPv4 loopback')
  ok(isPrivateAddress('10.2.3.4'), '网络边界识别 RFC1918 10/8')
  ok(isPrivateAddress('172.16.0.1'), '网络边界识别 RFC1918 172.16/12')
  ok(isPrivateAddress('192.168.1.20'), '网络边界识别 RFC1918 192.168/16')
  ok(isPrivateAddress('169.254.169.254'), '网络边界识别 link-local / metadata 地址')
  ok(isPrivateAddress('fd00::1234'), '网络边界识别 IPv6 unique-local')
  ok(isPrivateAddress('fe80::1'), '网络边界识别 IPv6 link-local')
  ok(isPrivateAddress('::ffff:127.0.0.1'), '网络边界识别 IPv4-mapped IPv6 loopback')
  ok(!isPrivateAddress('8.8.8.8'), '公网 IPv4 不被误判为私网')
  ok(!isPrivateAddress('2001:4860:4860::8888'), '公网 IPv6 不被误判为私网')
  ok(await resolvesToPrivateAddress('127.0.0.1'), '直接 IP 不绕过私网识别')
  ok(await resolvesToPrivateAddress('localhost'), '域名解析到 loopback 时被识别')
}
