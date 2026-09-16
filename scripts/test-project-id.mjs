/**
 * 项目 id 的派生与碰撞退路（D14）。
 *
 * 这条缺陷是 N19/L02 的边界探针发现的：同一父目录下的两个项目
 * （`.../pi-desktop` 与 `.../pi-desktop-2`）会派生出同一个 id，而
 * 「按 id 反查项目」的入口会把 cwd 判成不匹配，文件树 / `@` 补全直接报错。
 */
export function runProjectIdTests(ok, projectId) {
  const { legacyProjectId, hashedProjectId, projectIdForCwd } = projectId

  const a = 'C:\\Users\\YuDaTou\\Desktop\\pi-desktop'
  const b = 'C:\\Users\\YuDaTou\\Desktop\\pi-desktop-2'

  ok(legacyProjectId(a) === legacyProjectId(b), '旧算法确实会同前缀碰撞（先复现缺陷）')
  ok(/^project-[A-Za-z0-9_-]{36}$/.test(legacyProjectId(a)), '旧算法 id 形状不变（已有设置不必迁移）')

  /* 不碰撞时保持旧 id：老用户的会话归属键不能被动改动 */
  const taken = new Set([legacyProjectId(a)])
  const bId = projectIdForCwd(b, (id) => taken.has(id))
  ok(bId !== legacyProjectId(b), '碰撞时换用哈希 id', bId)
  ok(bId === hashedProjectId(b), '碰撞退路是整条路径的哈希（确定性）')
  ok(projectIdForCwd(b, (id) => taken.has(id)) === bId, '同一个 cwd 每次都得到同一个 id')

  const fresh = projectIdForCwd('D:\\work\\only-one', () => false)
  ok(fresh === legacyProjectId('D:\\work\\only-one'), '没有占用时沿用旧算法（迁移安全）')

  ok(legacyProjectId('C:\\Work\\App') === legacyProjectId('c:\\work\\app'), '大小写不敏感（Windows 路径同一性）')
  ok(hashedProjectId('C:\\Work\\App') === hashedProjectId('c:\\work\\app'), '哈希退路也大小写不敏感')

  /* 极端：哈希也被占用时仍要给出未占用的 id，而不是死循环/重复 */
  const all = new Set([legacyProjectId(b), hashedProjectId(b)])
  const salted = projectIdForCwd(b, (id) => all.has(id))
  ok(!all.has(salted) && salted.startsWith('project-'), '哈希再撞时继续加盐，直到拿到未占用的 id', salted)
}
