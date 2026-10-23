import type { Lang } from '../../i18n'

export interface OnboardingText {
  title: string
  subtitle: string
  stepsLabel: string
  close: string
  back: string
  next: string
  optional: string
  start: string
  stepOf: string
  loading: string

  stepWelcome: string
  stepTheme: string
  stepSound: string
  stepAuth: string
  stepContext: string
  stepDone: string

  welcomeTitle: string
  welcomeDesc: string
  welcomeAppearance: string
  welcomeSound: string
  welcomeAuth: string
  welcomeContext: string

  themeTitle: string
  themeDesc: string
  themeLabel: string
  langLabel: string
  themeLight: string
  themeDark: string
  themeNote: string

  soundTitle: string
  soundDesc: string
  soundEnable: string
  soundEnableDesc: string
  soundVolume: string

  authTitle: string
  authDesc: string
  authNote: string
  authOpen: string
  authModelHint: string

  contextTitle: string
  contextDesc: string
  contextLimit: string
  contextNow: string
  contextClamped: string
  contextNote: string

  doneTitle: string
  doneDesc: string
  entryInput: string
  entryTerminal: string
  entrySettings: string
  entrySidebar: string
  entryPhone: string
}

const ZH: OnboardingText = {
  title: '欢迎使用砚',
  subtitle: '几步配好常用项，之后都能在设置里改。',
  stepsLabel: '配置步骤',
  close: '跳过引导',
  back: '上一步',
  next: '下一步',
  optional: '可跳过',
  start: '开始使用',
  stepOf: '第 {n} / {total} 步',
  loading: '正在读取设置…',

  stepWelcome: '开始',
  stepTheme: '外观',
  stepSound: '提醒',
  stepAuth: '模型接入',
  stepContext: '上下文',
  stepDone: '功能入口',

  welcomeTitle: '先把这几件配置好',
  welcomeDesc: '下面几步里的每一项都可以跳过，之后在设置里随时再改。',
  welcomeAppearance: '外观：语言、主题与阅读偏好',
  welcomeSound: '提醒：完成、提问与出错时的声音',
  welcomeAuth: '模型接入：在设置里登录或填写凭证',
  welcomeContext: '上下文：自动压缩的触发上限',

  themeTitle: '外观',
  themeDesc: '先选界面语言和看得舒服的主题，密度、字号与字体稍后可在设置 → 外观里细调。',
  themeLabel: '主题',
  langLabel: '语言',
  themeLight: '浅色',
  themeDark: '深色',
  themeNote: '切换立即生效。',

  soundTitle: '提醒',
  soundDesc: '任务完成、需要你选择或出错时给一个提示音，避免长任务里错过。',
  soundEnable: '声音提示',
  soundEnableDesc: '开启后按事件播放提示音，默认关闭。',
  soundVolume: '音量',

  authTitle: '模型接入',
  authDesc: '砚通过已配置的模型服务对话。凭证只在设置里填写或登录，本向导不会读取你已保存的登录状态，也不会替你发起请求。',
  authNote: '支持 API Key，也支持订阅制账号（部分服务需先在终端完成一次登录）。',
  authOpen: '去设置配置模型',
  authModelHint: '填好凭证后回到这里点「下一步」继续。',

  contextTitle: '上下文',
  contextDesc: '会话上下文超过这个上限时，砚会调用 pi 原生的自动压缩。',
  contextLimit: '自动压缩上限',
  contextNow: '当前：{n}',
  contextClamped: '当前：{n}（窗口较小，实际按 {e} 触发）',
  contextNote: '压缩开关由 pi 管理；窗口未知时按所选上限执行。',

  doneTitle: '可以开始了',
  doneDesc: '这些入口随时可用，键位也可以在设置 → 快捷键里查看。',
  entryInput: '在底部输入框提问或派活',
  entryTerminal: '用终端直接执行命令',
  entrySettings: '设置里改模型、外观与能力',
  entrySidebar: '侧栏管理会话与项目',
  entryPhone: '手机连接电脑查看运行'
}

const EN: OnboardingText = {
  title: 'Welcome to Inkstone',
  subtitle: 'Set up the essentials in a few steps — everything stays editable in Settings.',
  stepsLabel: 'Setup steps',
  close: 'Skip setup',
  back: 'Back',
  next: 'Next',
  optional: 'Optional',
  start: 'Get started',
  stepOf: 'Step {n} of {total}',
  loading: 'Loading settings…',

  stepWelcome: 'Start',
  stepTheme: 'Appearance',
  stepSound: 'Alerts',
  stepAuth: 'Model access',
  stepContext: 'Context',
  stepDone: 'Entry points',

  welcomeTitle: 'A few things to set up',
  welcomeDesc: 'Every step can be skipped and changed later in Settings.',
  welcomeAppearance: 'Appearance: language, theme and reading preferences',
  welcomeSound: 'Alerts: sound for done, questions and errors',
  welcomeAuth: 'Model access: sign in or add credentials in Settings',
  welcomeContext: 'Context: the auto-compaction threshold',

  themeTitle: 'Appearance',
  themeDesc: 'Pick your language and a comfortable theme. Density, font size and typefaces are in Settings → Appearance.',
  themeLabel: 'Theme',
  langLabel: 'Language',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeNote: 'Applies immediately.',

  soundTitle: 'Alerts',
  soundDesc: 'Play a sound when a task finishes, needs your choice, or errors out.',
  soundEnable: 'Sound alerts',
  soundEnableDesc: 'Plays a cue per event; off by default.',
  soundVolume: 'Volume',

  authTitle: 'Model access',
  authDesc: 'Inkstone talks through your configured model services. Credentials are entered in Settings only — this wizard does not read saved logins or make any request for you.',
  authNote: 'API keys work, as do subscription accounts (some services need a one-time sign-in in the terminal).',
  authOpen: 'Configure models in Settings',
  authModelHint: 'Once credentials are in, come back and press Next.',

  contextTitle: 'Context',
  contextDesc: 'When a turn grows past this limit, Inkstone calls pi’s native auto-compaction.',
  contextLimit: 'Auto-compaction limit',
  contextNow: 'Current: {n}',
  contextClamped: 'Current: {n} (small window triggers at {e})',
  contextNote: 'The on/off switch is managed by pi; with an unknown window the chosen limit applies.',

  doneTitle: 'You are ready',
  doneDesc: 'These entry points are always available. Shortcuts live in Settings → Shortcuts.',
  entryInput: 'Ask or delegate in the composer below',
  entryTerminal: 'Run commands in the terminal',
  entrySettings: 'Change models, appearance and capabilities in Settings',
  entrySidebar: 'Manage sessions and projects in the sidebar',
  entryPhone: 'Connect your phone to watch runs'
}

export function onboardingText(lang: Lang): OnboardingText {
  return lang === 'en-US' ? EN : ZH
}
