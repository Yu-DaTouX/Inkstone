import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { linkHref } = await compile('src/main/browser/Observer.ts')
  const page = 'https://github.com/notifications?query=is%3Aunread'
  ok(linkHref('/o/r/actions/runs/1/job/2#step:7:17', undefined, page) === '/o/r/actions/runs/1/job/2#step:7:17', '同站链接只写路径并保留锚点')
  ok(linkHref('job/3', 'https://github.com/o/r/actions/runs/1/', page) === '/o/r/actions/runs/1/job/3', '相对地址按所在框架解析')
  ok(linkHref('https://user:pw@example.com/a?q=1', undefined, page) === 'https://example.com/a?q=1', '外站写全地址并去掉账号密码')
  ok(linkHref('/login?token=abc&next=/x&access_key=k', undefined, page) === '/login?token=%E2%80%A2&next=%2Fx&access_key=%E2%80%A2', '像凭据的查询参数值被遮住')
  ok(linkHref('javascript:void(0)', undefined, page) === undefined && linkHref('', undefined, page) === undefined, '脚本链接和空地址不显示')
  ok(linkHref('mailto:a@b.c', undefined, page) === 'mailto:a@b.c', '邮件链接原样显示')
  const long = linkHref(`/${'x'.repeat(200)}`, undefined, page)
  ok(long.length === 91 && long.endsWith('…'), '过长地址截断')
})
