/**
 * 量设计稿（prototype.html）的布局溢出。
 *
 * 为什么需要它：截图里「12m 被遮住」「新对话按钮边框不见」看着像两个 bug，
 * 但更可能是同一个根因 —— 容器内容比容器宽，溢出的部分被右邻的
 * 不透明列盖住了。肉眼只能看到「被遮挡」，量一下就知道宽了多少。
 *
 * 用法： npx electron scripts/measure-design.mjs
 */
import { app, BrowserWindow } from 'electron'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = resolve(root, 'docs/design/prototype.html')

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { sandbox: true }
  })

  await win.loadFile(FILE)

  const report = await win.webContents.executeJavaScript(`
    (() => {
      const out = []
      const q = (s) => document.querySelector(s)
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) } }

      out.push('=== 1. grid 容器：轨道是否允许收缩 ===')
      const gridSels = ['.app', '.workspace', '.titlebar', '.rail', '.center', '.item', '.msg', '.soul-line', '.kv', '.memrow', '.composer']
      for (const sel of gridSels) {
        const el = q(sel)
        if (!el) continue
        const cs = getComputedStyle(el)
        out.push(
          '  ' + sel.padEnd(14) +
          ' display=' + cs.display.padEnd(6) +
          ' cols=' + (cs.gridTemplateColumns || '-').slice(0, 46)
        )
      }

      out.push('')
      out.push('=== 2. 有没有元素比它的容器宽 ===')
      const bad = []
      document.querySelectorAll('.rail *, .status *, .titlebar *').forEach((el) => {
        const p = el.parentElement
        if (!p || !el.getBoundingClientRect().width) return
        const a = el.getBoundingClientRect()
        const b = p.getBoundingClientRect()
        const over = Math.round(a.right - b.right)
        if (over > 0) {
          bad.push({
            el: el.tagName + '.' + String(el.className || '').split(' ').filter(Boolean).join('.'),
            parent: p.tagName + '.' + String(p.className || '').split(' ').filter(Boolean).join('.'),
            over,
            text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 22)
          })
        }
      })
      out.push('  数量: ' + bad.length)
      bad.slice(0, 12).forEach((b) => out.push('  ✗ ' + b.el + ' ⤬ ' + b.parent + '  超出 ' + b.over + 'px  «' + b.text + '»'))

      out.push('')
      out.push('=== 3. 关键容器实测宽度 ===')
      for (const sel of ['.rail', '.rail-body', '.rail-foot', '.btn-new', '.item.sel', '.status', '.center']) {
        const el = q(sel)
        if (!el) { out.push('  ' + sel + ' 缺失'); continue }
        const cs = getComputedStyle(el)
        out.push(
          '  ' + sel.padEnd(12) +
          ' box=' + JSON.stringify(box(el)) +
          ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth +
          ' 差=' + (el.scrollWidth - el.clientWidth)
        )
      }

      out.push('')
      out.push('=== 4. 被盖住的元素（溢出到 rail 右边界之外）===')
      const rail = q('.rail')
      const rr = rail.getBoundingClientRect()
      out.push('  .rail 右边界 = ' + Math.round(rr.right))
      out.push('  .rail border-right 宽度 = ' + getComputedStyle(rail).borderRightWidth)
      document.querySelectorAll('.rail .item, .rail .btn-new, .rail .item .meta').forEach((el) => {
        const a = el.getBoundingClientRect()
        const over = Math.round(a.right - rr.right)
        if (over > 0 || el.classList.contains('btn-new')) {
          out.push(
            '  ' + (el.className.split(' ').join('.') || el.tagName).padEnd(28) +
            ' right=' + Math.round(a.right) +
            ' 超出rail=' + over +
            '  «' + (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 18) + '»'
          )
        }
      })

      out.push('')
      out.push('=== 5. 滚动条占位 ===')
      for (const sel of ['.rail-body', '.status']) {
        const el = q(sel)
        if (!el) continue
        const cs = getComputedStyle(el)
        out.push('  ' + sel.padEnd(12) + ' overflowX=' + cs.overflowX + ' overflowY=' + cs.overflowY + ' scrollbarGutter=' + cs.scrollbarGutter)
      }

      return out.join('\\n')
    })()
  `)

  console.log('设计稿: ' + FILE)
  console.log(report)

  // 断言：需要退出码，才能进 check 流水线
  const fails = []
  const overCount = /=== 2\. 有没有元素比它的容器宽 ===\n\s*数量: (\d+)/.exec(report)
  if (overCount && Number(overCount[1]) > 0) fails.push(`${overCount[1]} 个元素比容器宽`)

  // 逐行抓 「超出 Npx」里 N > 0 的
  for (const line of report.split('\n')) {
    const m = /超出 (\d+)px/.exec(line)
    if (m && Number(m[1]) > 0) fails.push(line.trim())
    const d = /差=(\d+)/.exec(line)
    if (d && Number(d[1]) > 0 && line.includes('scrollW')) fails.push('横向溢出：' + line.trim())
  }

  if (fails.length) {
    console.log('\n✗ 设计稿布局有问题：')
    fails.slice(0, 10).forEach((f) => console.log('  - ' + f))
    app.exit(1)
  } else {
    console.log('\n✓ 无溢出，无遮挡')
    app.exit(0)
  }
}

main().catch((e) => {
  console.error('✗ 失败：', e)
  app.exit(2)
})
