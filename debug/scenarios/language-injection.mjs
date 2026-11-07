export const meta = { description: '语言跟随提问：切换界面语言后新建会话发消息，系统提示里都是同一条「跟随用户最新消息」的指令（不依赖真实模型）' }

export default async function run({ cdp, fake, check, newSession, turn, sandboxProject }) {
  for (const lang of ['en-US', 'zh-CN']) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: ${JSON.stringify(lang)} })`)
    await newSession(sandboxProject)
    const before = fake.requests.length
    await turn('随便回一句')
    const sent = fake.requests.slice(before).find((request) => request.text.startsWith('随便回一句') && request.tools > 0)
    const instructions = sent?.instructions ?? ''
    check(`界面 ${lang}：系统提示要求跟随用户语言`, instructions.includes("language of the user's latest message"), instructions.length)
    check(`界面 ${lang}：没有写死界面语言`, !instructions.includes('简体中文') && !instructions.includes('must all be in English'))
  }
}
