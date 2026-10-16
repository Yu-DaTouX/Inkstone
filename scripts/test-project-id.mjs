export function runProjectIdTests(ok, projectId) {
  const { legacyProjectId, hashedProjectId, projectIdForCwd } = projectId

  const a = 'C:\\Users\\me\\Desktop\\pi-desktop'
  const b = 'C:\\Users\\me\\Desktop\\pi-desktop-2'

  ok(legacyProjectId(a) === legacyProjectId(b), '旧算法确实会同前缀碰撞（先复现缺陷）')
  ok(/^project-[A-Za-z0-9_-]{36}$/.test(legacyProjectId(a)), '旧算法 id 形状不变（已有设置不必迁移）')

  const taken = new Set([legacyProjectId(a)])
  const bId = projectIdForCwd(b, (id) => taken.has(id))
  ok(bId !== legacyProjectId(b), '碰撞时换用哈希 id', bId)
  ok(bId === hashedProjectId(b), '碰撞退路是整条路径的哈希（确定性）')
  ok(projectIdForCwd(b, (id) => taken.has(id)) === bId, '同一个 cwd 每次都得到同一个 id')

  const fresh = projectIdForCwd('D:\\work\\only-one', () => false)
  ok(fresh === legacyProjectId('D:\\work\\only-one'), '没有占用时沿用旧算法（迁移安全）')

  ok(legacyProjectId('C:\\Work\\App') === legacyProjectId('c:\\work\\app'), '大小写不敏感（Windows 路径同一性）')
  ok(hashedProjectId('C:\\Work\\App') === hashedProjectId('c:\\work\\app'), '哈希退路也大小写不敏感')

  const all = new Set([legacyProjectId(b), hashedProjectId(b)])
  const salted = projectIdForCwd(b, (id) => all.has(id))
  ok(!all.has(salted) && salted.startsWith('project-'), '哈希再撞时继续加盐，直到拿到未占用的 id', salted)

  const repo = 'C:\\Users\\me\\Desktop\\pi-desktop'
  const worktree = 'C:\\Users\\me\\Desktop\\pi-desktop-worktrees\\feat'
  ok(legacyProjectId(repo) === legacyProjectId(worktree), '前提：工作树与主仓库的旧算法 id 相同')
  const registered = new Set([legacyProjectId(repo)])
  const worktreeId = projectIdForCwd(worktree, (id) => registered.has(id))
  ok(worktreeId !== legacyProjectId(repo), '未登记的工作树不会共用主仓库的 id')
  ok(worktreeId === hashedProjectId(worktree), '工作树拿到整条路径的哈希 id（确定性、可重启复现）')
}
