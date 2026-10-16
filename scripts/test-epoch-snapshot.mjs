/**
 * 代次前进后的兜底完整快照（F07 host 侧）—— 专题回归。
 *
 * 从 `src/main/index.ts` 抽取**当前**的 `scheduleEpochSnapshots` 与其状态声明，验证：
 *   · 首次观察只登记、不重复推；
 *   · 某实例代次前进时补一帧完整快照（`pushRunnerSnapshot`），同代次不重复；
 *   · 实例移除后清掉登记，不残留、不误推。
 *
 * 函数文本是真实的；`runners.statuses()` 与 `pushRunnerSnapshot` 是受控桩。
 */
import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runEpochSnapshotTests(ok) {
  const indexFile = fileURLToPath(new URL('../src/main/index.ts', import.meta.url))
  const source = await fs.readFile(indexFile, 'utf8')
  const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const pickDecl = (name) => {
    const node = sf.statements.find(
      (n) => ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)
    )
    if (!node) throw new Error('Missing declaration ' + name)
    return node.getText(sf)
  }
  const fn = sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'scheduleEpochSnapshots')
  if (!fn) throw new Error('Missing scheduleEpochSnapshots')
  const code = ts.transpileModule(
    [pickDecl('publishedRunnerGenerations'), pickDecl('epochSnapshotScheduled'), fn.getText(sf),
      'globalThis.testScheduleEpochSnapshots = scheduleEpochSnapshots;'].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText

  const statuses = []
  const pushed = []
  const context = {
    runners: { statuses: () => statuses.map((s) => ({ id: s.id, generation: s.generation })) },
    pushRunnerSnapshot: (id) => pushed.push(id),
    queueMicrotask
  }
  vm.createContext(context)
  vm.runInContext(code, context)
  const tick = () => new Promise((resolve) => queueMicrotask(resolve))

  /* ① 首次观察只登记，不推 */
  statuses.push({ id: 'r1', generation: 1 }, { id: 'r2', generation: 5 })
  context.testScheduleEpochSnapshots()
  await tick()
  await tick()
  ok(pushed.length === 0, '首次观察只登记代次，不重复推快照', JSON.stringify(pushed))

  /* ② 同代次重复触发不推 */
  context.testScheduleEpochSnapshots()
  await tick()
  await tick()
  ok(pushed.length === 0, '同代次重复通知不推快照')

  /* ③ r1 代次前进：补一帧 */
  statuses[0].generation = 2
  context.testScheduleEpochSnapshots()
  await tick()
  await tick()
  ok(pushed.length === 1 && pushed[0] === 'r1', '代次前进的实例补一帧完整快照', JSON.stringify(pushed))

  /* ④ 再触发同代次：不重复 */
  context.testScheduleEpochSnapshots()
  await tick()
  await tick()
  ok(pushed.length === 1, '代次未再前进时不重复推', JSON.stringify(pushed))

  /* ⑤ 实例移除：登记被清掉；新实例首次只登记 */
  statuses.length = 0
  statuses.push({ id: 'r3', generation: 1 })
  context.testScheduleEpochSnapshots()
  await tick()
  await tick()
  ok(pushed.length === 1, '被移除实例的登记被清理，新实例首次不误推', JSON.stringify(pushed))

  /* ⑥ 防重入：并发调度只执行一次 */
  statuses[0].generation = 2
  context.testScheduleEpochSnapshots()
  context.testScheduleEpochSnapshots()
  await tick()
  await tick()
  ok(pushed.length === 2 && pushed[1] === 'r3', '同一轮多次通知合并为一次快照', JSON.stringify(pushed))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runEpochSnapshotTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  })
  console.log(`Epoch snapshot tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
