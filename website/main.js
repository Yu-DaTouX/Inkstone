import { mountStone } from './stone.js'

const root = document.documentElement
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const reduce = params.has('still') || matchMedia('(prefers-reduced-motion: reduce)').matches
const clamp = (value) => Math.max(0, Math.min(1, value))
const store = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch {} }
}

const EN = {
  'nav.steps': 'Steps',
  'nav.approve': 'Approval',
  'nav.bench': 'Workspace',
  'nav.phone': 'Phone',
  'hero.title': 'Give ideas their shape.',
  'hero.sub': 'Hand it the job and it does the work itself: code, research, web pages and files, with every step in plain sight.',
  'hero.pi': 'built on pi',
  'cta.download': 'Download for Windows',
  'cta.source': 'View source',
  'demo': 'demo',
  'steps.title': 'Every step in plain sight',
  'steps.lead': 'The answer reads straight through while thinking and tool steps unfold on demand. Which files it read, which lines it changed, what it ran: all in the session, ending with a clear account of the result.',
  'steps.pane': 'session',
  'approve.title': 'Risky steps ask first',
  'approve.lead': 'Under auto-approve, routine work just runs. Dangerous operations and writes outside the project wait for you: allow once, allow for the session, or refuse.',
  'approve.pane': 'approval',
  'approve.why': 'Git force push, overwrites remote history',
  'approve.once': 'Allow once',
  'approve.session': 'Allow in this session',
  'approve.deny': 'Deny',
  'approve.again': 'again',
  'bench.title': 'Results right beside the chat',
  'bench.lead': 'Changes, web pages and the terminal open as tabs in the side panel. Pages the agent drives show up right here, and you can take over at any time.',
  'bench.pane': 'workspace',
  'bench.ask': 'Add "Remember me" to the login page and try it in the browser.',
  'bench.t1': 'Edit src/pages/Login.tsx',
  'bench.t2': 'Open localhost:5173/login',
  'bench.t3': 'Run npm test',
  'bench.t3out': '24 passed',
  'bench.tab1': 'Changes',
  'bench.tab2': 'Browser',
  'bench.tab3': 'Terminal',
  'bench.take': 'Take over',
  'bench.remember': 'Remember me',
  'agents.title': 'Sub-agents split the work',
  'agents.lead': 'Give each subtask its own model and let them run in parallel. Progress rolls up into the session, and you can cut in while they run.',
  'agents.pane': 'sub-agents',
  'compact.title': 'Long tasks keep going',
  'compact.lead': 'Near the context limit you set, the session compacts itself: a summary stays, and the original snapshot can still be looked up.',
  'compact.pane': 'context',
  'phone.title': 'Pick it up on your phone',
  'phone.lead': 'Pair the Android client with your computer to follow progress, reply, approve and switch models. Still in testing.',
  'phone.paired': 'paired',
  'phone.session': 'Dark theme for login',
  'phone.l1': '2 files edited',
  'phone.l2': 'Run npm test',
  'phone.allow': 'Allow',
  'phone.deny': 'Deny',
  'more.title': 'Also in the box',
  'more.k1': 'Models',
  'more.v1': 'Sign in to a model service or paste an API key; switch model and thinking level at any time.',
  'more.k2': 'Skills & MCP',
  'more.v2': 'Configured globally or per project.',
  'more.k3': 'Snapshots',
  'more.v3': 'Eligible projects save a local snapshot before each send, for preview and rollback.',
  'more.k4': 'Next line',
  'more.v4': 'A grey guess at what you will say next. Tab accepts it.',
  'more.k5': 'Plugins',
  'more.v5': 'Voice input, a desktop pet and ComfyUI, installed on demand.',
  'more.k6': 'Your data',
  'more.v6': 'Chats and settings stay on your own computer.',
  'start.title': 'Get started',
  'start.s1': 'Download the installer and run it. Updates arrive in the background.',
  'start.s2': 'Sign in under Settings → Models, or paste an API key.',
  'start.s3': 'Start a session, pick a project folder, say what you need.',
  'start.all': 'Portable build, Android and changelog',
  'start.note': 'The installer is not code-signed yet, so Windows may warn about an unknown publisher; download only from the GitHub releases page. Desktop ships for Windows x64 today; the Android client is in testing.',
  'foot.pi': 'built on pi',
  'foot.issues': 'Feedback',
  'st.get': 'Download'
}
const ZH = {}
for (const el of document.querySelectorAll('[data-i18n]')) ZH[el.dataset.i18n] = el.textContent
const TAPE = {
  zh: document.querySelector('.tape-run span').textContent,
  en: 'write code / research / drive web pages / read and write files / session terminal / git changes and commits / sub-agents / skills / MCP / plugins / phone handoff / local snapshots / '
}

const STREAM = [
  { kind: 'user', zh: '把登录页改成深色主题，再跑一遍测试。', en: 'Switch the login page to a dark theme, then run the tests.' },
  { kind: 'tool', zh: '读取 3 个文件', en: 'Read 3 files' },
  { kind: 'tool', zh: '编辑 src/pages/Login.tsx', en: 'Edit src/pages/Login.tsx', add: 18, del: 4 },
  { kind: 'tool', zh: '编辑 src/theme.css', en: 'Edit src/theme.css', add: 6, del: 1 },
  { kind: 'tool', zh: '运行 npm test', en: 'Run npm test', outZh: '24 项通过', outEn: '24 passed' },
  { kind: 'say', zh: '深色主题改好了，测试全部通过。改动都在工作区，你确认后我再提交。', en: 'The dark theme is in and every test passes. The changes sit in the working tree; I will commit once you confirm.' },
  { kind: 'card', zh: '编辑 2 个文件', en: '2 files edited', add: 24, del: 5 }
]
const TOOL_SPAN = [[0.04, 0.19], [0.19, 0.35], [0.35, 0.49], [0.49, 0.67]]
const SAY_SPAN = [0.67, 0.93]
const CARD_AT = 0.95
const VERDICT = {
  once: { zh: '已允许这一次。命令执行完毕，下次遇到还会再问。', en: 'Allowed once. The command ran; the next one will ask again.' },
  session: { zh: '已在此会话中允许。本会话内同类操作不再询问。', en: 'Allowed for this session. The same kind of step will not ask again here.' },
  deny: { zh: '已拒绝，命令没有执行。', en: 'Denied. The command did not run.' }
}
const LANES = [
  { name: 'explore', rate: 1.55, zh: '3 处调用', en: '3 call sites' },
  { name: 'tests', rate: 1.05, zh: '新增 4 项', en: '4 added' },
  { name: 'docs', rate: 1.28, zh: '1 个文件', en: '1 file' }
]
const TEXT = {
  main: { zh: '主会话', en: 'main session' },
  merged: { zh: '3 个子任务完成，结果已汇总。', en: '3 subtasks done, results merged back.' },
  ctx: { zh: '已用', en: 'used' },
  limit: { zh: '自动压缩上限', en: 'auto-compact limit' },
  idle: { zh: '对话继续', en: 'Conversation continues' },
  packing: { zh: '压缩中', en: 'Compacting' },
  packed: { zh: '已压缩，留下摘要与原文快照', en: 'Compacted: summary and snapshot kept' }
}
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const TABS = ['diff', 'web', 'term']
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&$@+=<>/[]{}'
const WORD = ['INK', 'STONE']
const CMD = 'git push --force origin main'
const SEG = 8

let lang = 'zh'
let frame = 2
let picked = TABS.includes(params.get('tab'))

const say = (key) => TEXT[key][lang]
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
const node = (tag, cls, text) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}
const fill = (bar, part) => {
  const cells = Math.floor(bar.parentNode.clientWidth / SEG)
  bar.style.width = `${Math.max(0, Math.round(part * cells) * SEG - 3)}px`
}
function spin(el, on, mark) {
  if (on) {
    if (el.dataset.spin === undefined) {
      el.dataset.spin = ''
      el.textContent = SPIN[frame % SPIN.length]
    }
  } else {
    delete el.dataset.spin
    el.textContent = mark
  }
}
function type(el, text, count, caret) {
  const key = `${count}|${caret}|${text}`
  if (el._typed === key) return
  el._typed = key
  if (count >= text.length && !caret) {
    el.textContent = text
    return
  }
  const parts = [text.slice(0, count)]
  if (caret) parts.push(node('span', 'caret'))
  parts.push(node('span', 'rest', text.slice(count)))
  el.replaceChildren(...parts)
}
function typeIn(el, step) {
  const text = el.textContent
  if (reduce || !text) return
  const host = el.parentNode
  const id = (el._run = (el._run || 0) + 1)
  let count = 0
  host.classList.add('typing')
  type(el, text, 0, true)
  const timer = setInterval(() => {
    if (el._run !== id) {
      clearInterval(timer)
      return
    }
    count++
    if (count < text.length) {
      type(el, text, count, true)
      return
    }
    clearInterval(timer)
    type(el, text, text.length, false)
    host.classList.remove('typing')
  }, step)
}

function decodeWord() {
  const spans = [...$('word').children]
  const startAt = performance.now()
  const step = (now) => {
    const elapsed = now - startAt
    let index = 0
    let open = false
    spans.forEach((span, which) => {
      let out = ''
      for (const letter of WORD[which]) {
        if (elapsed >= 380 + index * 135) out += letter
        else {
          out += glyph()
          open = true
        }
        index++
      }
      span.textContent = out
    })
    if (open) setTimeout(() => requestAnimationFrame(step), 48)
    else setTimeout(glitch, 5200)
  }
  const glitch = () => {
    if (scrollY < innerHeight * 0.6 && !document.hidden) {
      const which = Math.random() < 0.375 ? 0 : 1
      const at = Math.floor(Math.random() * WORD[which].length)
      let ticks = 0
      const timer = setInterval(() => {
        const letters = [...WORD[which]]
        if (ticks < 4) letters[at] = glyph()
        spans[which].textContent = letters.join('')
        if (++ticks > 4) clearInterval(timer)
      }, 62)
    }
    setTimeout(glitch, 3600 + Math.random() * 5200)
  }
  requestAnimationFrame(step)
}

const stream = { rows: [] }
function buildStream() {
  const body = $('streamBody')
  body.replaceChildren()
  stream.rows = STREAM.map((item) => {
    const row = node('div', `ln ${item.kind}`)
    const tail = node('span', 'tail')
    if (item.add !== undefined) {
      const diff = node('span', 'diff')
      diff.append(node('b', '', `+${item.add}`), ' ', node('i', '', `−${item.del}`))
      tail.append(diff)
    } else if (item.outZh) {
      tail.append(node('span', 'out', lang === 'zh' ? item.outZh : item.outEn))
    }
    row.append(node('span', 'st', item.kind === 'user' ? '>' : item.kind === 'card' ? '±' : ''), node('span', 'tx', item[lang]), tail)
    body.append(row)
    return row
  })
}
function paintStream(p) {
  let tool = 0
  STREAM.forEach((item, i) => {
    const row = stream.rows[i]
    if (item.kind === 'tool') {
      const [from, to] = TOOL_SPAN[tool++]
      const done = p >= from + (to - from) * 0.62
      row.classList.toggle('off', p < from)
      row.classList.toggle('done', done)
      row.classList.toggle('run', !done)
      spin(row.firstChild, !done, '✓')
      row.lastChild.classList.toggle('off', !done)
    } else if (item.kind === 'say') {
      const text = item[lang]
      row.classList.toggle('off', p < SAY_SPAN[0])
      type(row.children[1], text, Math.round(text.length * clamp((p - SAY_SPAN[0]) / (SAY_SPAN[1] - SAY_SPAN[0]))), p < SAY_SPAN[1])
    } else if (item.kind === 'card') {
      row.classList.toggle('off', p < CARD_AT)
    }
  })
}

function setVerdict(state) {
  $('approval').dataset.state = state
  $('verdict').textContent = state === 'ask' ? '' : VERDICT[state][lang]
}
function paintApproval(p) {
  type($('cmdText'), CMD, Math.round(CMD.length * clamp((p - 0.05) / 0.45)), p < 0.5)
  $('approval').classList.toggle('s1', p >= 0.55)
  $('approval').classList.toggle('s2', p >= 0.7)
}

function setTab(name) {
  const pane = $('benchPane')
  if (pane.dataset.tab === name && pane.querySelector('.view.on')) return
  pane.dataset.tab = name
  for (const el of pane.querySelectorAll('[data-tab]')) {
    const on = el.dataset.tab === name
    el.classList.toggle('on', on)
    if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', String(on))
  }
  for (const el of pane.querySelectorAll('[data-view]')) el.classList.toggle('on', el.dataset.view === name)
}
function paintBench(p) {
  if (picked || reduce) return
  setTab(p < 0.38 ? 'diff' : p < 0.7 ? 'web' : 'term')
}

const lanes = { rows: [], sum: null }
function buildLanes() {
  const body = $('lanesBody')
  body.replaceChildren(node('div', 'lane-root'))
  lanes.rows = LANES.map((lane, i) => {
    const row = node('div', 'lane')
    const bar = node('span', 'bar')
    bar.append(node('i'))
    row.append(node('span', 'tw', i === LANES.length - 1 ? '└─' : '├─'), node('span', 'st'), node('span', 'nm', lane.name), bar, node('span', 'tail'))
    body.append(row)
    return row
  })
  lanes.sum = node('p', 'lane-sum')
  body.append(lanes.sum)
}
function paintLanes(p) {
  const parts = LANES.map((lane) => clamp(p * lane.rate))
  $('lanesBody').firstChild.textContent = say('main')
  lanes.rows.forEach((row, i) => {
    const done = parts[i] >= 1
    row.classList.toggle('done', done)
    spin(row.children[1], !done, '✓')
    fill(row.children[3].firstChild, parts[i])
    row.lastChild.textContent = done ? LANES[i][lang] : `${Math.round(parts[i] * 100)}%`
  })
  lanes.sum.textContent = `✓ ${say('merged')}`
  lanes.sum.hidden = !parts.every((part) => part >= 1)
}

const meter = {}
function buildMeter() {
  const top = node('div', 'meter-top')
  top.append(node('span'), node('span'))
  const bar = node('span', 'bar big')
  bar.append(node('i'), node('i', 'sum'), node('b'))
  const lim = node('div', 'meter-lim')
  lim.append(node('span'))
  const row = node('div', 'ln tool')
  row.append(node('span', 'st'), node('span', 'tx'), node('span', 'tail'))
  $('meterBody').replaceChildren(top, bar, lim, row)
  Object.assign(meter, { label: top.firstChild, num: top.lastChild, used: bar.children[0], sum: bar.children[1], lim: lim.firstChild, row })
}
function paintMeter(p) {
  const state = p < 0.5 ? 'idle' : p < 0.62 ? 'packing' : 'packed'
  const used = state === 'idle' ? 0.24 + 0.56 * (p / 0.5) : state === 'packing' ? 0.8 : 0.1 + 0.27 * ((p - 0.62) / 0.38)
  meter.label.textContent = say('ctx')
  meter.num.textContent = `${Math.round(used * 200)}k / 200k`
  meter.lim.textContent = say('limit')
  fill(meter.used, used)
  fill(meter.sum, state === 'packed' ? 0.1 : 0)
  meter.row.className = `ln tool ${state === 'packing' ? 'run' : state === 'packed' ? 'done' : 'idle'}`
  meter.row.children[1].textContent = say(state)
  spin(meter.row.firstChild, state === 'packing', state === 'packed' ? '✓' : '·')
}

function paintPair(p) {
  const pair = $('pair')
  pair.classList.toggle('s1', p >= 0.15)
  pair.classList.toggle('s2', p >= 0.35)
  pair.classList.toggle('s3', p >= 0.6)
}

const scenes = [
  { el: $('stream'), paint: paintStream },
  { el: $('approval'), paint: paintApproval },
  { el: $('benchPane'), paint: paintBench },
  { el: $('lanes'), paint: paintLanes },
  { el: $('meter'), paint: paintMeter },
  { el: $('pair'), paint: paintPair }
].map((scene) => ({ ...scene, p: reduce ? 1 : 0 }))
const repaint = () => { for (const scene of scenes) scene.paint(scene.p) }

const hero = $('hero')
const secs = [...document.querySelectorAll('[data-sec]')]
let current = -2
let queued = false
function paintStatus() {
  const at = Math.max(0, current)
  const pad = (value) => String(value).padStart(2, '0')
  $('stNum').textContent = `${pad(at + 1)}/${pad(secs.length)}`
  $('stName').textContent = (lang === 'zh' ? ZH : EN)[secs[at].querySelector('h2 [data-i18n]').dataset.i18n]
}
function onFrame() {
  queued = false
  const view = innerHeight
  const top = scrollY
  const span = root.scrollHeight - view
  const atEnd = top >= span - 4
  if (!reduce) {
    const out = clamp(top / (hero.offsetHeight * 0.75))
    hero.style.setProperty('--sp', out.toFixed(3))
    if (stone) stone.setScatter(out)
    for (const scene of scenes) {
      const edge = scene.el.getBoundingClientRect().top
      const p = atEnd && edge < view ? 1 : Math.round(clamp((view * 0.86 - edge) / (view * 0.5)) * 300) / 300
      if (edge < view * 0.92) scene.el.classList.add('in')
      if (p === scene.p) continue
      scene.p = p
      scene.paint(p)
    }
  }
  let at = -1
  secs.forEach((sec, i) => { if (sec.getBoundingClientRect().top < view * 0.55) at = i })
  if (at !== current) {
    current = at
    secs.forEach((sec, i) => sec.classList.toggle('now', i === at))
    paintStatus()
  }
  const done = span > 0 ? clamp(top / span) : 0
  fill($('stFill'), done)
  $('stPct').textContent = `${Math.round(done * 100)}%`
  $('status').classList.toggle('on', top > hero.offsetHeight * 0.6)
}
function onScroll() {
  if (queued) return
  queued = true
  requestAnimationFrame(onFrame)
}

function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh'
  root.lang = lang === 'zh' ? 'zh-CN' : 'en'
  const dict = lang === 'zh' ? ZH : EN
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el._run = (el._run || 0) + 1
    el._typed = null
    el.parentNode.classList.remove('typing')
    el.textContent = dict[el.dataset.i18n] ?? ZH[el.dataset.i18n]
  }
  for (const el of document.querySelectorAll('.tape-run span')) el.textContent = TAPE[lang].repeat(4)
  $('lang').textContent = lang === 'zh' ? 'EN' : '中文'
  $('lang').setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文')
  store.set('inkstone-lang', lang)
  setVerdict($('approval').dataset.state)
  buildStream()
  repaint()
  paintStatus()
}

const stone = mountStone({ canvas: $('stone'), hero, word: $('word'), pitch: $('pitch') })

function setTheme(next) {
  const theme = next === 'light' ? 'light' : 'dark'
  root.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#FCFCFB' : '#000000'
  store.set('inkstone-theme', theme)
  if (stone) stone.setLight(theme === 'light')
}

for (const list of document.querySelectorAll('.specs, .how')) [...list.children].forEach((el, i) => el.style.setProperty('--i', i))
buildLanes()
buildMeter()
setTheme(params.get('theme') || store.get('inkstone-theme') || 'dark')
setLang(params.get('lang') || store.get('inkstone-lang') || 'zh')
setTab(picked ? params.get('tab') : 'diff')
onFrame()

$('lang').onclick = () => setLang(lang === 'zh' ? 'en' : 'zh')
$('theme').onclick = () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light')
$('again').onclick = () => setVerdict('ask')
for (const button of document.querySelectorAll('.choices button')) button.onclick = () => setVerdict(button.dataset.act)
for (const el of $('benchPane').querySelectorAll('[data-tab]')) {
  el.onclick = () => {
    picked = true
    setTab(el.dataset.tab)
  }
}
addEventListener('scroll', onScroll, { passive: true })
addEventListener('resize', onScroll)
new ResizeObserver(() => { repaint(); onScroll() }).observe($('lanesBody'))

const marked = [...document.querySelectorAll('.rv:not(.pane)')]
if (reduce) {
  for (const el of document.querySelectorAll('.rv')) el.classList.add('in')
} else {
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      seen.unobserve(entry.target)
      entry.target.classList.add('in')
      if (entry.target.tagName === 'H2') typeIn(entry.target.querySelector('[data-i18n]'), 34)
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' })
  for (const el of marked) seen.observe(el)
  setInterval(() => {
    frame++
    for (const el of document.querySelectorAll('[data-spin]')) el.textContent = SPIN[frame % SPIN.length]
  }, 90)
  decodeWord()
  setTimeout(() => typeIn(document.querySelector('h1 [data-i18n]'), 72), 520)
}

fetch('https://api.github.com/repos/Yu-DaTouX/Inkstone/releases/latest', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000) })
  .then((response) => (response.ok ? response.json() : null))
  .then((release) => {
    if (!release || !/^v\d/.test(release.tag_name || '')) return
    for (const el of document.querySelectorAll('[data-version]')) el.textContent = release.tag_name
  })
  .catch(() => {})
