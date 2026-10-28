export const meta = { description: '应用刚启动就新建会话：视图必须落到新会话，不停在旧的空会话（配合 --repeat 多跑几次）' }

export default async function run({ cdp, state, until, check, box }) {
  await until('s.sessions.length > 0', 30000, 20)
  const result = await cdp.evaluate(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(box.project)} })`)
  check('newSession 返回成功', result?.ok !== false, result)
  const landed = await until(`s.session?.cwd === ${JSON.stringify(box.project)}`, 3000, 20)
  check('一次调用就落到新会话', landed, await state('({ cwd: s.session?.cwd, id: s.session?.sessionId, active: s.activeRunnerId })'))
}
