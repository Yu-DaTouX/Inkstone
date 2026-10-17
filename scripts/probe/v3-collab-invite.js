;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const field = (testId) => {
    const node = q(testId)
    return node?.matches('input') ? node : node?.querySelector('input')
  }

  try {
    out.push('=== v3 协作邀请链接（隔离探针）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
    check(await until(() => q('v3-collab-pair-form'), 8000), '启动参数里的 inkstone://pair 深链打开协作页配对表单')
    check(window.location.hash.includes('collab'), `路由切到协作页（hash=${window.location.hash}）`)
    const filled = await until(() => field('v3-collab-pair-address')?.value === 'http://100.64.0.7:37892' && field('v3-collab-pair-code')?.value === '246810', 4000)
    check(filled, `表单预填地址与配对码（地址=${field('v3-collab-pair-address')?.value ?? '无'}，配对码=${field('v3-collab-pair-code')?.value ?? '无'}）`)
    check(/收到邀请链接|Invite link received/.test(document.body.innerText), '提示用户确认后再点配对')
    check(!/已配对「|配对失败：|Paired with “|Pairing failed:/.test(document.body.innerText), '没有自动发起配对请求')

    const invite = q('v3-collab-invite')
    check(!!invite, '协作者区显示「邀请协作者」卡片')
    check(await until(() => q('v3-collab-invite-unavailable'), 6000), '隔离环境未开启接入时说明原因而不是生成链接')
    check(!q('v3-collab-invite-start') && !q('v3-collab-invite-active'), '未开启接入时不提供生成邀请按钮')

    invite?.scrollIntoView({ block: 'center' })
    const box = invite?.getBoundingClientRect()
    const page = document.querySelector('.collab-page') ?? document.body
    check(!!box && box.width > 0 && box.right <= page.getBoundingClientRect().right + 1, '邀请卡片在页面宽度内')
    check(document.documentElement.scrollWidth <= window.innerWidth + 1, '页面没有横向溢出')
    await wait(2500)
    out.push('证据范围：隔离数据目录、启动参数深链、协作页 DOM；未开启真实接入、未生成真实配对码。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
