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
  ok(isPrivateAddress('fc00:0:0:0:0:0:0:1'), '网络边界识别完整写法 IPv6 unique-local')
  ok(isPrivateAddress('fe80:0:0:0:0:0:0:1'), '网络边界识别完整写法 IPv6 link-local')
  ok(isPrivateAddress('0:0:0:0:0:0:0:1'), '网络边界识别完整写法 IPv6 loopback')
  ok(isPrivateAddress('0:0:0:0:0:0:0:0'), '网络边界识别完整写法 IPv6 unspecified')
  ok(isPrivateAddress('0:0:0:0:0:ffff:127.0.0.1'), '网络边界识别完整写法 IPv4-mapped IPv6 loopback')
  ok(isPrivateAddress('fd00:0:0:0:1:2:3:4'), '网络边界识别完整写法 fd00::/8')
  ok(isPrivateAddress('fe80::1%eth0'), '带 zone id 的 link-local 仍被识别')
  for (const [compressed, expanded] of [
    ['fc00::1', 'fc00:0:0:0:0:0:0:1'],
    ['fe80::1', 'fe80:0:0:0:0:0:0:1'],
    ['::1', '0:0:0:0:0:0:0:1'],
    ['::', '0:0:0:0:0:0:0:0'],
    ['::ffff:192.168.0.1', '0:0:0:0:0:ffff:192.168.0.1'],
    ['2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888']
  ]) {
    ok(
      isPrivateAddress(compressed) === isPrivateAddress(expanded),
      `压缩与完整写法分类一致：${compressed} / ${expanded}`
    )
  }
  ok(!isPrivateAddress('8.8.8.8'), '公网 IPv4 不被误判为私网')
  ok(!isPrivateAddress('2001:4860:4860::8888'), '公网 IPv6 不被误判为私网')
  ok(!isPrivateAddress('2001:4860:4860:0:0:0:0:8888'), '公网 IPv6 完整写法不被误判为私网')
  ok(await resolvesToPrivateAddress('127.0.0.1'), '直接 IP 不绕过私网识别')
  ok(await resolvesToPrivateAddress('localhost'), '域名解析到 loopback 时被识别')

  const { PrivateDnsGuard } = policy
  let lookups = 0
  const release = []
  const guard = new PrivateDnsGuard(async () => {
    lookups += 1
    await new Promise((resolve) => release.push(resolve))
    return false
  })
  const shared = [guard.resolves('Example.COM.'), guard.resolves('example.com'), guard.resolves('example.com')]
  ok(lookups === 1, '同一主机并发查询只解析一次')
  release.splice(0).forEach((resolve) => resolve())
  ok((await Promise.all(shared)).every((value) => value === false), '并发查询共享同一结果')
  ok((await guard.resolves('example.com')) === false, '已缓存的结果直接命中')
  ok(lookups === 1, '缓存命中时不再解析')
  const failing = new PrivateDnsGuard(async () => {
    throw new Error('dns 挂了')
  })
  ok((await failing.resolves('broken.test')) === false, '解析失败的域名当作公网（不阻断正常浏览）')
}
