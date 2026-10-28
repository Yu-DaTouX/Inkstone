export const meta = { description: '切走再切回并激活：从磁盘读回的消息带上回合计时与生成计时，消息数不变' }

export default async function run({ cdp, state, waitFor, check, newSession, turn }) {
  await newSession()
  const path = await state('s.session.sessionFile')
  await turn('你好')
  await turn('再来一次')
  const timings = `s.messages.filter((m) => m.role === 'assistant').map((m) => ({ id: m.id, turn: m.turnTiming?.elapsedMs ?? null, gen: !!m.generationTiming }))`
  const before = await state(timings)
  check('两回合都带生成计时', before.filter((m) => m.gen).length === 2, before)

  await newSession()
  await cdp.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(path)})`)
  await waitFor(`!s.switchLoading && s.session?.sessionFile === ${JSON.stringify(path)}`, 30000, 20)
  const activated = await cdp.evaluate('window.__yanStore.getState().ensureActivated()')
  check('切回后激活成功', activated !== false, activated)
  await waitFor('!s.pendingActivation && !s.peekedPath', 15000, 20)
  const after = await state(timings)
  check('激活后助手消息数不变', after.length === before.length, { before: before.length, after: after.length })
  check('激活后每个回合都带回合计时', after.every((m) => typeof m.turn === 'number'), after)
  check('激活后生成计时仍在', after.every((m) => m.gen), after)
}
