/** W1 尾巴：创建成功后把新工作树登记为可独立打开的项目（方案 §6.2） */
import { readFileSync, writeFileSync } from 'node:fs'

/* ── 1. i18n ── */
{
  const zh = { 'env.worktreeRegistered': '已登记为项目' }
  const en = { 'env.worktreeRegistered': 'registered as a project' }
  for (const [file, add] of [
    ['src/renderer/src/i18n/zh-CN.json', zh],
    ['src/renderer/src/i18n/en-US.json', en]
  ]) {
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    for (const [k, v] of Object.entries(add)) obj[k] = v
    const sorted = Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
    writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n')
  }
  console.log('✓ i18n：+1 键')
}

/* ── 2. EnvironmentMenu：创建成功后登记项目 ── */
{
  const p = 'src/renderer/src/components/review/EnvironmentMenu.tsx'
  let s = readFileSync(p, 'utf8')

  /* 取 settings / patchSettings */
  const hookAnchor = `  const repoView = useRepoState(project ?? '')`
  const hookAdd = `  const repoView = useRepoState(project ?? '')
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)`
  if (!s.includes(hookAnchor)) {
    console.error('✗ repoView 锚点没找到')
    process.exit(1)
  }
  s = s.replace(hookAnchor, hookAdd)

  /* 创建成功 → 登记为项目 */
  const from = `                              setWtBranch('')
                              setWtPath('')
                              repoView.refresh()`
  const to = `                              setWtBranch('')
                              setWtPath('')
                              repoView.refresh()
                              /*
                               * 登记为项目（方案 §6.2：创建成功后要能**独立打开**）。
                               *
                               * 这里只写 settings.projects 一条记录，不动 cwd、不切会话 ——
                               * 「创建完就自动跳过去」会把用户正在做的事打断，而且
                               * W2 的会话重绑定还没做（§6.3 要求做不到就别假装能）。
                               * 已存在同 cwd 的项目就不重复登记。
                               */
                              const list = settings?.projects ?? []
                              if (!list.some((x) => x.cwd.toLowerCase() === made.toLowerCase())) {
                                const now = Date.now()
                                void patchSettings({
                                  projects: [
                                    ...list,
                                    {
                                      id: \`wt-\${now.toString(36)}\`,
                                      cwd: made,
                                      name: res.branch ?? made.split(/[\\\\/]/).pop() ?? made,
                                      archived: false,
                                      createdAt: now,
                                      updatedAt: now
                                    }
                                  ]
                                })
                              }`
  if (!s.includes(from)) {
    console.error('✗ 创建成功分支没找到')
    process.exit(1)
  }
  s = s.replace(from, to)

  /* useStore import */
  if (!s.includes("from '../../state/store'")) {
    const impAnchor = `import { useRepoState } from './useGitReview'`
    if (!s.includes(impAnchor)) {
      console.error('✗ useRepoState import 没找到')
      process.exit(1)
    }
    s = s.replace(impAnchor, `import { useRepoState } from './useGitReview'\nimport { useStore } from '../../state/store'`)
  }
  writeFileSync(p, s)
  console.log('✓ EnvironmentMenu：登记为项目')
}
