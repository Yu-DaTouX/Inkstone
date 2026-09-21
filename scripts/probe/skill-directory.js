/**
 * 独立 Skill 目录的真实发现证据（实施-04 S6b-2，cost 0）。
 *
 * 这条场景只做 discover：目录响应来自配置的真实外部 API，SkillMD 风格的
 * `items` 条目还会被主进程逐条读取 raw_url 并计算 SHA-256。它不 prepare、
 * 不 acquire，也不执行外部 Skill；因此可以验证「外部目录 → 固定文件清单」
 * 的边界，而不会把未授权的第三方内容装进测试环境。
 */
;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => {
    out.push(`  ${cond ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return Boolean(cond)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  if (!store || !window.yan?.runBash) {
    out.push('✗ 没有 window.__yanStore / runBash（探针没被注入）')
    return out.join('\n')
  }

  const runCli = async (command, waitMs = 90_000) => {
    const raced = await Promise.race([
      window.yan
        .runBash(command)
        .then((value) => ({ done: 'ok', value }))
        .catch((error) => ({ done: 'err', error: String((error && error.message) || error) })),
      sleep(waitMs).then(() => ({ done: 'timeout' }))
    ])
    if (raced.done !== 'ok') return { exitCode: null, output: '', error: raced.error ?? `命令超时（${raced.done}）` }
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(120)
      const messages = store.getState().messages.filter((message) => message.role === 'bash')
      const last = messages[messages.length - 1]
      const call = last && last.toolCalls && last.toolCalls[0]
      if (last && call && call.status !== 'running' && call.status !== 'pending') {
        return { exitCode: last.bash ? last.bash.exitCode : null, output: call.output ?? '' }
      }
    }
    return { exitCode: null, output: '', error: '等待工具行完成超时' }
  }

  const lastJson = (text) => {
    const lines = String(text).split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]) } catch { /* 继续找回执 */ }
    }
    return null
  }

  const readJsonFile = async (path) => {
    const result = await runCli(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))" "${path}"`)
    try { return JSON.parse(result.output) } catch { return null }
  }

  const readReceipt = async (output) => {
    const summary = lastJson(output)
    if (!summary) return null
    if (summary.resultFile) {
      const full = await readJsonFile(summary.resultFile)
      if (full) return { ...full, __summary: summary }
    }
    return summary
  }

  const readyDeadline = Date.now() + 30_000
  while (Date.now() < readyDeadline && store.getState().conn !== 'ready') await sleep(250)
  if (!ok(store.getState().conn === 'ready', '宿主已就绪（conn=ready）')) return out.join('\n')

  /* 用目录里当前可固定的真实条目做窄查询，避免 npm 的同名高热度包挤掉 Skill 候选。 */
  const discovered = await runCli('yan capabilities discover --query-text "futurediffusion filesystem"')
  const receipt = await readReceipt(discovered.output)
  if (!ok(Boolean(receipt), 'discover 返回回执', discovered.error ?? discovered.output.slice(0, 500))) return out.join('\n')

  const sources = Array.isArray(receipt.sources) ? receipt.sources : []
  const candidates = Array.isArray(receipt.candidates) ? receipt.candidates : []
  const source = sources.find((item) => item.sourceId === 'skill-directory')
  const skill = candidates.find((candidate) => String(candidate.candidateId).startsWith('skill-directory:'))
  out.push(`  Skill 目录源：${JSON.stringify(source ?? null)}`)
  out.push(`  Skill 候选：${JSON.stringify(skill ?? null)}`)

  ok(Boolean(source), '回执记录 skill-directory 来源')
  ok(source?.ok === true, 'Skill 目录真实请求成功', String(source?.error ?? ''))
  ok(Number(source?.candidateCount) > 0, 'Skill 目录返回了可固定候选', String(source?.candidateCount))
  ok(Boolean(skill), '候选进入统一排名结果')
  ok(skill?.installKind === 'skill-files', '独立 Skill 映射为 skill-files')
  ok(typeof skill?.commit === 'string' && skill.commit.length >= 7, '候选固定到目录 commit', String(skill?.commit))
  ok(skill?.verification === 'metadata-only', '候选仍标 metadata-only（来源可读不等于已审计）')
  const filePaths = skill?.skillFileUrls && typeof skill.skillFileUrls === 'object' ? Object.keys(skill.skillFileUrls) : []
  const hashes = skill?.skillFileHashes && typeof skill.skillFileHashes === 'object' ? Object.values(skill.skillFileHashes) : []
  ok(filePaths.length > 0 && filePaths.every((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path)), '候选只有安全的 SKILL.md 相对路径', JSON.stringify(filePaths))
  ok(filePaths.every((path) => /^https:\/\//.test(String(skill.skillFileUrls[path]))), '候选保留逐文件 HTTPS raw 来源')
  ok(hashes.length === filePaths.length && hashes.every((hash) => /^[a-f0-9]{64}$/i.test(String(hash))), '每个文件都有主进程重新计算的 SHA-256')
  ok(!receipt.executable, 'discover 只读，不返回可执行接入结果')
  return out.join('\n')
})()
