import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { sameNameHints } = await compile('src/renderer/src/features/workbench/rail-data.ts', { external: ['react'] })

  const basic = sameNameHints(['src/shared/friction.ts', 'src/main/friction.ts', 'src/main/ipc/friction-ipc.ts'])
  ok(basic.get('src/shared/friction.ts') === 'shared' && basic.get('src/main/friction.ts') === 'main', '同名文件补上一级目录')
  ok(!basic.has('src/main/ipc/friction-ipc.ts'), '不同名的文件不补目录')

  const deep = sameNameHints(['a/x/index.ts', 'b/x/index.ts', 'c/y/index.ts'])
  ok(deep.get('a/x/index.ts') === 'a/x' && deep.get('b/x/index.ts') === 'b/x', '上一级相同时继续往上找到能区分的层')
  ok(deep.get('c/y/index.ts') === 'c/y', '同组统一用同一层深度')

  const windows = sameNameHints(['E:\\repo\\docs\\README.md', 'README.md'])
  ok(windows.get('E:\\repo\\docs\\README.md') === 'docs' && !windows.has('README.md'), 'Windows 路径可用，根目录文件没有目录可补')

  const caseInsensitive = sameNameHints(['a/Readme.md', 'b/README.md'])
  ok(caseInsensitive.get('a/Readme.md') === 'a' && caseInsensitive.get('b/README.md') === 'b', '文件名大小写不同也算同名')
})
