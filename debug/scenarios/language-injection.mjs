export const meta = { description: '语言跟随界面：切换界面语言后立刻新建会话发消息，系统提示里的语言指令应与当前界面语言一致（不依赖真实模型）' }

export default async function run({ cdp, fake, check, newSession, turn, sandboxProject, sleep }) {
  const directive = (text) => (text.includes('简体中文') ? 'zh-CN' : text.includes('must all be in English') ? 'en-US' : 'none')
  for (const [lang, wait] of [['en-US', 0], ['zh-CN', 0], ['en-US', 0], ['zh-CN', 1500]]) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: ${JSON.stringify(lang)} })`)
    if (wait) await sleep(wait)
    await newSession(sandboxProject)
    const before = fake.requests.length
    await turn('随便回一句')
    const sent = fake.requests.slice(before).find((request) => request.text.startsWith('随便回一句') && request.tools > 0)
    check(`界面 ${lang}（切换后等待 ${wait}ms）：系统提示的语言指令一致`, directive(sent?.instructions ?? '') === lang, directive(sent?.instructions ?? ''))
  }
}
