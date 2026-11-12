import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const guard = await import(pathToFileURL(resolve('resources/pi-extensions/danger-guard.js')).href)
  const dirs = Array.from({ length: 9 }, (_, index) => `D:/out${index}/a.txt`)
  const command = dirs.map((path) => `echo x > ${path}`).join(' && ')
  const hits = guard.outsideWrites('bash', { command }, 'C:/proj', { outsideWrites: true, allowRoots: [] })
  ok(hits.length === 9, '\u9879\u76ee\u5916\u5199\u5165\u76ee\u6807\u4e0d\u518d\u53ea\u53d6\u524d 6 \u4e2a', String(hits.length))

  const grants = await compile('src/main/approval-session-grants.ts')
  ok(grants.sessionGrantKey({ kind: 'outside', tool: 'bash', reasons: [] }) === null, '\u6ca1\u6709\u53ef\u8bb0\u4f4f\u76ee\u5f55\u7684\u9879\u76ee\u5916\u5199\u5165\u4e0d\u751f\u6210\u4f1a\u8bdd\u6388\u6743\u952e\uff0c\u907f\u514d\u4e00\u6b21\u6388\u6743\u653e\u884c\u4efb\u610f\u76ee\u5f55')
  const a = grants.sessionGrantKey({ kind: 'outside', tool: 'bash', rememberDirs: ['D:/a', 'D:/b'] })
  const b = grants.sessionGrantKey({ kind: 'outside', tool: 'bash', rememberDirs: ['D:/a', 'D:/c'] })
  ok(!!a && a !== b, '\u4e0d\u540c\u76ee\u5f55\u96c6\u5408\u7684\u4f1a\u8bdd\u6388\u6743\u952e\u4e0d\u540c')
})
