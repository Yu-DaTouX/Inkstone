import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dir = new URL('../.tmp/site-icon/', import.meta.url)
await mkdir(dir, { recursive: true })
const bundle = new URL('loader.mjs', dir)
await build({ entryPoints: [fileURLToPath(new URL('../src/main/search/site-icon.ts', import.meta.url))], outfile: fileURLToPath(bundle), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
const { createSiteIconLoader, siteIconCandidates, encodedSiteIcon } = await import(bundle.href)
let checks = 0
const check = (name, value) => { assert.ok(value, name); checks++; console.log(`PASS ${name}`) }
const png = 'data:image/png;base64,dGVzdA=='
const response = (body = 'image', type = 'image/png', url = 'https://site.example/') => ({ status: 200, body: new TextEncoder().encode(body), contentType: type, headers: {}, finalUrl: url })

const ico = Buffer.alloc(26)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico.writeUInt32LE(4, 14)
ico.writeUInt32LE(22, 18)
check('ICO 目录合法时交给图像上下文解码', encodedSiteIcon(ico, 'image/x-icon')?.startsWith('data:image/x-icon;base64,'))
ico.writeUInt32LE(999, 18)
check('拒绝 ICO 越界目录', encodedSiteIcon(ico, 'image/x-icon') === null)
check('SVG 只编码为图像数据', encodedSiteIcon(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')?.startsWith('data:image/svg+xml;base64,'))
check('拒绝 SVG 实体声明', encodedSiteIcon(new TextEncoder().encode('<!DOCTYPE svg><svg/>'), 'image/svg+xml') === null)

const candidates = siteIconCandidates(`<link href="/brand.svg" rel="icon"><link REL='apple-touch-icon' href='/apple.png?v=1&amp;x=2'><link rel=icon href=javascript:alert(1)><link rel=icon href=http://127.0.0.1/a.png><link rel=stylesheet href=/theme.css>`, 'https://site.example/')
check('发现站点声明图标，优先 PNG 并解码实体', candidates[0] === 'https://site.example/apple.png?v=1&x=2')
check('排除脚本、本机地址和非图标链接', candidates.length === 2)

let calls = []
let now = 0
let release
const delayed = new Promise((resolve) => { release = resolve })
const load = createSiteIconLoader({ now: () => now, png: async () => png, fetch: async (url, signal, options) => { calls.push({ url, options }); await delayed; return response() } })
const first = load('https://site.example/private/article?token=secret')
const second = load('https://site.example/another')
release()
check('同站点并发只请求一次', await first === png && await second === png && calls.length === 1)
check('图标请求不含原页面路径或查询参数', calls[0].url === 'https://site.example/favicon.ico')
check('图标下载有独立大小限制', calls[0].options.maxBytes === 256 * 1024)
check('成功图标复用缓存', await load('https://site.example/third') === png && calls.length === 1)
for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'file:///C:/a.ico', 'https://user:pass@site.example/']) check(`拒绝非公开图标地址 ${url}`, await load(url) === null)
check('被拒绝地址没有发出网络请求', calls.length === 1)

calls = []
const discover = createSiteIconLoader({ now: () => 0, png: async () => png, fetch: async (url) => {
  calls.push(url)
  if (url.endsWith('/favicon.ico')) return response('<html>not an icon</html>', 'text/html')
  if (url.endsWith('/')) return response('<link rel="icon" href="/brand.png">', 'text/html', url)
  return response()
} })
check('favicon 不是图片时发现网页声明的图标', await discover('https://custom.example/a') === png && calls[2] === 'https://custom.example/brand.png')

let failures = 0
const failed = createSiteIconLoader({ now: () => now, png: async () => null, fetch: async () => { failures++; throw new Error('unavailable') } })
check('网络失败安全返回空图标', await failed('https://offline.example/') === null)
const count = failures
await failed('https://offline.example/a')
check('失败缓存避免重复下载', failures === count)
now += 5 * 60 * 1000 + 1
await failed('https://offline.example/')
check('失败缓存到期后允许重试', failures > count)

let active = 0
let maxActive = 0
const bounded = createSiteIconLoader({ now: () => 0, png: async () => png, fetch: async () => {
  active++; maxActive = Math.max(maxActive, active)
  await new Promise((resolve) => setTimeout(resolve, 5))
  active--
  return response()
} })
const all = await Promise.all(Array.from({ length: 12 }, (_, i) => bounded(`https://site${i}.example/`)))
check('多站点只同时加载四个图标并完成排队', maxActive === 4 && all.every((value) => value === png))
console.log(`网站图标：${checks} 项通过`)
