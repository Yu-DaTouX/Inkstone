function assert(condition, message) {
  if (!condition) throw new Error(`latest-only test failed: ${message}`)
}

export async function runLatestOnlyTests() {
  const { createLatestOnly } = await import('../out/test/latest-only.mjs')

  {
    const guard = createLatestOnly()
    const token = guard.begin()
    assert(guard.isCurrent(token), '一次请求在返回时仍是最新的')
  }

  {
    const guard = createLatestOnly()
    const a = guard.begin()
    const b = guard.begin()
    assert(guard.isCurrent(b), '后发起的请求是最新的')
    assert(!guard.isCurrent(a), '先发起的请求在 B 发出后就不是最新的了')
    assert(guard.isCurrent(b), 'B 的判定不受 A 的影响')
  }

  {
    const guard = createLatestOnly()
    const token = guard.begin()
    guard.invalidate()
    assert(!guard.isCurrent(token), 'invalidate 之后在途请求全部过期')
    const next = guard.begin()
    assert(guard.isCurrent(next), '作废之后新发起的请求重新有效')
  }

  {
    const guard = createLatestOnly()
    const first = guard.begin()
    guard.invalidate()
    const second = guard.begin()
    assert(second > first, '新令牌必须大于旧令牌')
    assert(!guard.isCurrent(first), '旧令牌不会因为新令牌递增而又变有效')
  }

  console.log('latest-only: 代次判定、迟到丢弃、卸载作废、令牌单调 passed')
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  await runLatestOnlyTests()
}
