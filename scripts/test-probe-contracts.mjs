import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'src/renderer/src'
const PROBES = ['v3-queuestack', 'atrefsend', 'permissions', 'v3-projectmenu', 'v3-shell']
const TEXT_EXT = /\.(ts|tsx|css)$/

const NEGATIVE = new Map([  ['app-shell', 'v2 外壳不应存在，探针必须保留这条负向断言'],
  ['wb-pane', '旧 wb 工作区叶子不应挂载'],
  ['terminal-host', '结束时不应有终端宿主'],
  ['term-pane', '旧终端面板类名'],
  ['v3-head-settings', '顶栏不应单独放设置按钮']
])

function walk(dir, out = []) {  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (TEXT_EXT.test(name)) out.push(path)
  }
  return out
}

function corpus() {
  const files = walk(ROOT)
  const texts = files.map((file) => readFileSync(file, 'utf8'))
  const tokens = new Set()
  for (const text of texts) {
    for (const [, token] of text.matchAll(/["'`]([a-z0-9][a-z0-9-]{2,})["'`]/g)) tokens.add(token)
  }
  return { text: texts.join('\n'), tokens }
}

const COMPOSED = new Map([
  ['t3-sidebar-utility-settings', /t3-sidebar-utility-\$\{entry\.key\}/],
  ['v3-settings-nav-appearance', /v3-settings-nav-\$\{entry\.section\}/]
])

function literalTestIds(source) {
  const ids = new Set()
  for (const [, id] of source.matchAll(/data-testid="([^"${}]+)"/g)) ids.add(id)
  for (const [, id] of source.matchAll(/\b(?:query|qa)\('([^'${}]+)'\)/g)) ids.add(id)
  for (const [, id] of source.matchAll(/\[data-testid="([^"${}]+)"\]/g)) ids.add(id)
  return ids
}

function testIdKnown(store, id) {
  if (store.tokens.has(id)) return true
  if (store.text.includes(`"${id}-`)) return true
  if (store.text.includes(`${id}-\${`)) return true
  const composed = COMPOSED.get(id)
  if (composed) return composed.test(store.text)
  const base = /^[a-z0-9-]*[a-z0-9]/.exec(id)?.[0]?.replace(/-+$/, '')
  if (base && base !== id) return store.text.includes(`${base}-\${`) || store.text.includes(`${base}-`)
  return false
}

function classSelectors(source) {
  const found = new Set()
  const prefix = /^\.((?:t3|v3|rp|wb|mtp|cp|cmd|ui|composer|nsp|usage|start|term|sidebar|settings|home|css)-[a-z0-9_-]+)/
  for (const [, selector] of source.matchAll(/["'`]([^"'`\n]{2,160})["'`]/g)) {
    for (const part of selector.split(/[\s,>+~]+/)) {
      const match = prefix.exec(part)
      if (match) found.add(match[1])
    }
  }
  return found
}

const problems = []
const checked = []

function ok(condition, label, detail) {
  checked.push(label)
  if (!condition) problems.push(`${label}${detail ? `：${detail}` : ''}`)
}

const store = corpus()
const probeSources = new Map(PROBES.map((name) => [name, readFileSync(`scripts/probe/${name}.js`, 'utf8')]))

for (const [name, source] of probeSources) {
  ok(!source.includes('__yanComposer'), `${name} 不依赖不存在的 window.__yanComposer`)
  for (const id of literalTestIds(source)) {
    if (NEGATIVE.has(id)) continue
    ok(testIdKnown(store, id), `${name} 的选择器在渲染端源码中存在`, id)
  }
  for (const cls of classSelectors(source)) {
    if (NEGATIVE.has(cls)) continue
    ok(store.text.includes(cls), `${name} 的类选择器在渲染端源码中存在`, cls)
  }
}

const shell = probeSources.get('v3-shell')
ok(/!document\.querySelector\('\.app-shell'\)/.test(shell), 'v3-shell 保留「没有同时挂载 v2 外壳」的负向断言')
ok(/\.wb-pane/.test(shell), 'v3-shell 保留 wb 工作区叶子不挂载的负向断言')
ok(/terminal\.list\(\)/.test(shell), 'v3-shell 仍在结束时核对宿主终端表为空')
ok(/browserState\?\.open === browserBefore/.test(shell), 'v3-shell 仍核对没有隐式打开原生网页')

const queue = probeSources.get('v3-queuestack')
ok(/steerQueued/.test(queue) && /removeQueued/.test(queue), 'v3-queuestack 仍核对插话与撤回接线')
ok(/queue-edit-input/.test(queue) && /queue-clear-all/.test(queue), 'v3-queuestack 覆盖行内编辑与全部清除')

const perms = probeSources.get('permissions')
ok(/v3-security-all-confirm/.test(perms), 'permissions 覆盖设置里的「不受限制」确认')
ok(/data-composer-permission-trigger/.test(perms), 'permissions 覆盖输入框权限入口')

const project = probeSources.get('v3-projectmenu')
ok(/sidebar-project-folder/.test(project) && /v3-project-more/.test(project), 'v3-projectmenu 使用当前侧栏项目分区选择器')
ok(/shelf:settled/.test(project), 'v3-projectmenu 用已归档架核对归档结果')
ok(/v3-project-filter-archived/.test(project), 'v3-projectmenu 用项目过滤面板恢复项目')

const atref = probeSources.get('atrefsend')
ok(/data-composer-command-root/.test(atref), 'atrefsend 使用当前补全菜单根节点')
ok(/\bexecCommand\('insertText'/.test(atref), 'atrefsend 通过原生编辑命令写入 ProseMirror 输入框')

const live = readFileSync('scripts/test-live.mjs', 'utf8')
for (const name of PROBES) ok(live.includes(`scripts/probe/${name}.js`), `${name} 仍在 test-live 场景表里注册`)
ok(/'v3-shell':[\s\S]{0,200}keys: 'ctrl\+k,escape,enter'/.test(live), 'v3-shell 场景仍注入真实 Chromium 按键')

if (problems.length === 0) console.log(`✓ 探针静态契约 ${checked.length} 项通过`)
else {
  for (const problem of problems) console.log(`✗ ${problem}`)
  console.log(`✗ ${problems.length}/${checked.length} 项失败`)
  process.exit(1)
}

export { literalTestIds, classSelectors, testIdKnown, corpus, relative }
