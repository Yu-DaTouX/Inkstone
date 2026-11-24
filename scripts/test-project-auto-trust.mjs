import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { trustProjectFolders } = await compile('src/main/project-auto-trust.ts')
  const table = { 'E:/explicit-no': false, 'E:/explicit-yes': true }
  const allowed = []
  const deps = {
    status: async (cwd) => cwd in table ? { trusted: table[cwd], entry: cwd } : { trusted: cwd === 'E:/default-trusted', entry: null },
    allow: async (cwd) => { allowed.push(cwd); return { ok: cwd !== 'E:/write-fails' } },
    isDirectory: async (cwd) => cwd !== 'E:/missing'
  }
  const projects = ['E:/new', 'E:/explicit-no', 'E:/explicit-yes', 'E:/default-trusted', 'E:/missing', 'E:/write-fails'].map((cwd) => ({ cwd, name: cwd }))
  const trusted = await trustProjectFolders(projects, deps)
  ok(trusted.map((p) => p.cwd).join() === 'E:/new', '只信任还没有任何信任记录、且目录存在的项目，并返回它们用于提示')
  ok(!allowed.includes('E:/explicit-no'), '用户手动取消过信任的项目保持不信任')
  ok(!allowed.includes('E:/explicit-yes') && !allowed.includes('E:/default-trusted'), '已经信任的项目不重复写')
  ok(!allowed.includes('E:/missing'), '目录不存在时不写信任')
  ok(allowed.includes('E:/write-fails') && !trusted.some((p) => p.cwd === 'E:/write-fails'), '写入失败不报成已信任')
  const thrown = await trustProjectFolders([{ cwd: 'E:/boom' }, { cwd: 'E:/new' }], { ...deps, status: async (cwd) => { if (cwd === 'E:/boom') throw new Error('x'); return { trusted: false, entry: null } } })
  ok(thrown.length === 1 && thrown[0].cwd === 'E:/new', '某个项目读信任出错时不影响其他项目')
})
