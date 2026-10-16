;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (await predicate()) return true
      } catch {
      }
      await wait(100)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const store = window.__yanStore
  const TEST_MODEL = 'commandcode/deepseek/deepseek-v4.1-flash'

  const isTerminal = (phase) => phase && (phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'stopped')
  const todayKey = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const parseFindings = (text) => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
    const candidate = (fenced ? fenced[1] : text).trim()
    const start = candidate.indexOf('[')
    const end = candidate.lastIndexOf(']')
    if (start < 0 || end <= start) return { ok: false }
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      return Array.isArray(parsed) ? { ok: true, findings: parsed } : { ok: false }
    } catch {
      return { ok: false }
    }
  }

  try {
    out.push('=== v3 只读评审 R 运行（真实模型）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 10000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }

    const cwd = store.getState().settings?.cwd || store.getState().session?.cwd || ''
    check(!!cwd, `场景 cwd 可用（${cwd}）`)

    const piReady = await until(() => store.getState().conn === 'ready', 120000)
    check(piReady, `pi 已就绪（conn=${store.getState().conn}）`)
    const defectSource = [
      'const HARDCODED_API_KEY = "sk-live-hardcoded-secret"',
      'export function ratio(a, b) {',
      '  return a / (b - b)',
      '}',
      ''
    ].join('\n')
    let defectPath = ''
    if (cwd && piReady && window.yan?.runBash) {
      const rel = 'defect-review.js'
      const abs = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${rel}`
      const b64 = btoa(unescape(encodeURIComponent(defectSource)))
      const res = await window.yan.runBash(
        `node -e "require('fs').writeFileSync('${abs}', Buffer.from('${b64}','base64'))"`
      )
      const written = await until(async () => {
        const st = await window.yan.statPreview(rel, cwd).catch(() => null)
        return st?.ok === true
      }, 10000)
      if (res?.ok !== false && written) defectPath = rel
      note(`缺陷文件 ${rel}：runBash ok=${res?.ok} 已落盘=${written}`)
    }
    if (!defectPath) note('未写入缺陷文件，只用现有脏改动做评审')

    const csBefore = await window.yan.review.changeSet({ source: 'uncommitted', cwd })
    check(csBefore?.ok === true && (csBefore.files?.length ?? 0) > 0, `未提交变更集可读（${csBefore?.files?.length ?? 0} 个文件）`)
    const target = (csBefore.files ?? []).find((f) => !f.binary && f.status !== 'deleted' && !f.untracked && f.status !== 'renamed')
      ?? (csBefore.files ?? []).find((f) => !f.binary && f.status !== 'deleted')
    const revBefore = csBefore.revision
    let statBefore = null
    if (target) {
      const st = await window.yan.statPreview(target.path, cwd)
      if (st?.ok) statBefore = { path: target.path, mtimeMs: st.mtimeMs, size: st.size }
    }
    note(`只读基线文件：${target ? target.path : '(无文本文件)'}${statBefore ? ` mtime=${statBefore.mtimeMs} size=${statBefore.size}` : ''}`)

    const session = store.getState().session
    const started = await window.yan.review.start({
      query: { source: 'uncommitted', cwd },
      model: TEST_MODEL,
      ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session?.sessionFile ? { sessionPath: session.sessionFile } : {})
    })
    check(started?.ok === true, `评审运行已启动（${started?.error ?? 'ok'}）`)
    check(/^R\d+/.test(started?.code ?? ''), `编号以 R 开头（${started?.code}）`)
    const runId = started?.runId
    check(!!runId, `返回子运行 runId（${runId}）`)

    out.push('')
    out.push('--- 运行注册表 ---')
    let snapshot = await window.yan.runs.snapshot()
    let entry = (snapshot.runs ?? []).find((r) => r.runId === runId)
    if (!entry) {
      await wait(1500)
      snapshot = await window.yan.runs.snapshot()
      entry = (snapshot.runs ?? []).find((r) => r.runId === runId)
    }
    check(!!entry, '运行注册表出现该运行')
    check(entry?.kind === 'review', `运行时 kind='review'（${entry?.kind}）`)
    check(entry?.code === started?.code, `注册表 code 与返回一致（${entry?.code}）`)

    const phaseSeq = []
    let terminalSnap = null
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      const snap = await window.yan.runs.snapshot()
      const run = (snap.runs ?? []).find((r) => r.runId === runId)
      const kind = run?.phase?.kind ?? 'gone'
      if (!phaseSeq.length || phaseSeq[phaseSeq.length - 1] !== kind) phaseSeq.push(kind)
      if (run && isTerminal(run.phase)) {
        terminalSnap = run
        break
      }
      await wait(400)
    }
    note(`运行阶段序列：${phaseSeq.join(' → ')}`)
    check(!!terminalSnap, `评审运行进入终态（${terminalSnap?.phase?.kind}）`)
    const terminalKind = terminalSnap?.phase?.kind

    let reopened = false
    const settleEnd = Date.now() + 5000
    while (Date.now() < settleEnd) {
      const snap = await window.yan.runs.snapshot()
      const run = (snap.runs ?? []).find((r) => r.runId === runId)
      if (run && !isTerminal(run.phase)) reopened = true
      await wait(400)
    }
    check(!reopened, '终态后没有再次回到运行中（收口一次）')

    let historyRecord = null
    const historyEnd = Date.now() + 30000
    while (Date.now() < historyEnd) {
      try {
        const hist = await window.yan.runs.history({ date: todayKey(), filters: { kind: ['review'] }, limit: 200 })
        const matches = (hist.records ?? []).filter((r) => r.code === started?.code)
        if (matches.length >= 1) {
          historyRecord = matches
          break
        }
      } catch {
      }
      await wait(500)
    }
    check(Array.isArray(historyRecord) && historyRecord.length === 1, `运行历史里该 R 号恰好一条记录（${historyRecord?.length ?? 0}）`)
    if (historyRecord?.[0]) {
      check(historyRecord[0].terminal === 'done', `历史终态为 done（${historyRecord[0].terminal}）`)
      if (typeof historyRecord[0].costUsd === 'number') note(`历史记录费用 ≈ $${historyRecord[0].costUsd.toFixed(6)}`)
    }

    out.push('')
    out.push('--- 只读 ---')
    const csAfter = await window.yan.review.changeSet({ source: 'uncommitted', cwd })
    check(csAfter?.ok === true, '评审后变更集仍可读')
    check(csAfter?.revision === revBefore, `变更集 revision 未变（${String(revBefore).slice(0, 12)}…）`)
    check((csAfter?.files?.length ?? 0) === (csBefore.files?.length ?? 0), `文件数未变（${csAfter?.files?.length ?? 0}）`)
    if (statBefore) {
      const st = await window.yan.statPreview(statBefore.path, cwd)
      check(st?.ok === true && st.mtimeMs === statBefore.mtimeMs && st.size === statBefore.size, `目标文件 stat 未变（${statBefore.path}）`)
    }

    out.push('')
    out.push('--- 评审意见返回 ---')
    let sub = null
    let findingsText = ''
    const findingsEnd = Date.now() + 60000
    while (Date.now() < findingsEnd) {
      const list = await window.yan.subagents.list()
      sub = (list ?? []).find((s) => s.id === runId)
      findingsText = (sub?.transcript ?? [])
        .filter((m) => m.role === 'assistant')
        .map((m) => m.text ?? '')
        .join('\n')
        .trim()
      if (sub && (sub.status === 'done' || sub.status === 'error' || sub.status === 'cancelled') && findingsText) break
      await wait(500)
    }
    check(!!sub, '找到评审子运行记录')
    if (sub) note(`子运行状态=${sub.status} 工具调用=${sub.toolCalls ?? 'n/a'} 模型=${sub.model ?? 'n/a'}`)
    check(findingsText.length > 0, '评审子运行返回了助手文本')
    const parsed = parseFindings(findingsText)
    check(parsed.ok, '助手文本包含可解析的 JSON findings 数组')
    if (parsed.ok) note(`findings 条数=${parsed.findings.length}`)
    const findingsNonEmpty = parsed.ok && parsed.findings.length > 0
    const referencedPatch = /defect-review|HARDCODED_API_KEY|b - b|B - B|除零|密钥|写死/i.test(findingsText)
    if (defectPath) {
      check(findingsNonEmpty || referencedPatch, `findings 非空或引用了补丁内容（findings=${parsed.ok ? parsed.findings.length : '?'}，引用=${referencedPatch}）`)
    } else {
      note('未写入缺陷文件，跳过「findings 非空或引用补丁」断言')
    }
    if (findingsText) note(`意见摘要：${JSON.stringify(findingsText.replace(/\s+/g, ' ').slice(0, 240))}`)

    out.push('证据范围：真实只读评审子运行；模型固定 commandcode/deepseek/deepseek-v4.1-flash；不 push / 不提交。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
