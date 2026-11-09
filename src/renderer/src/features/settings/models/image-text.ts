import type { ImageService } from '../../../../../shared/image-config'
import type { Lang } from '../../../i18n/lang'

interface ImageText {
  title: string
  description: string
  defaultService: string
  auto: string
  unavailable: string
  mock: string
  autoHint: string
  service: Record<ImageService, string>
  note: Record<ImageService, string>
  signedIn: string
  notSignedIn: string
  detected: string
  notDetected: string
  keySaved: string
  keyElsewhere: string
  noKey: string
  inUse: string
  complexity: string
  complexityDesc: string
  complexityDefault: string
  complexityLow: string
  complexityMedium: string
  complexityHigh: string
  baseUrl: string
  model: string
  keyPlaceholder: string
  keyReplace: string
  keyOverride: string
  save: string
  clear: string
  keySavedMsg: string
  keyClearedMsg: string
  failed: string
}

const zh: ImageText = {
  title: '生图',
  description: '让 AI 画图时用哪个服务、哪个模型。模型留空则用默认值；key 只保存在本机。',
  defaultService: '默认服务',
  auto: '自动',
  unavailable: '无可用服务',
  mock: '本地预览',
  autoHint: '按顺序取第一个可用的，当前是「{name}」',
  service: { codex: 'ChatGPT 登录', compatible: '兼容接口', openai: 'OpenAI', google: 'Google', doubao: '豆包', local: '本地服务' },
  note: {
    codex: '使用「登录与订阅」里的 ChatGPT 账号，无需 key。图像模型和思考强度由 ChatGPT 服务端决定，这里不能指定。',
    compatible: '任何兼容 OpenAI 图像接口的中转或自建服务。',
    openai: '没填 key 时，会读取「API Key」里已有的 OpenAI key。',
    google: '没填 key 时，会读取「API Key」里已有的 Google key。',
    doubao: '没填 key 时，会读取「API Key」里已有的火山方舟 key。',
    local: '自动检测本机的 SD WebUI 等服务，无需配置。'
  },
  signedIn: '已登录',
  notSignedIn: '未登录',
  detected: '已检测到',
  notDetected: '未检测到',
  keySaved: '已保存 key',
  keyElsewhere: '已有 key（来自其他设置）',
  noKey: '未配置',
  inUse: '默认',
  complexity: '思考强度',
  complexityDesc: '生图前规划多少：低适合小改动，高适合文字多、布局复杂的图。仅 GPT Image 2.6 经 OpenAI 或兼容接口时有效，默认高。',
  complexityDefault: '默认',
  complexityLow: '低',
  complexityMedium: '中',
  complexityHigh: '高',
  baseUrl: '接口地址',
  model: '模型',
  keyPlaceholder: '粘贴 API key',
  keyReplace: '已保存，输入新 key 可替换',
  keyOverride: '输入后优先使用这里的 key',
  save: '保存',
  clear: '清除',
  keySavedMsg: 'key 已保存',
  keyClearedMsg: 'key 已清除',
  failed: '保存失败'
}

const en: ImageText = {
  title: 'Image generation',
  description: 'Which service and model draw images for the AI. Leave a model empty to use its default. Keys stay on this device.',
  defaultService: 'Default service',
  auto: 'Auto',
  unavailable: 'No service available',
  mock: 'Local preview',
  autoHint: 'Uses the first available one, currently "{name}"',
  service: { codex: 'ChatGPT sign-in', compatible: 'Compatible endpoint', openai: 'OpenAI', google: 'Google', doubao: 'Doubao', local: 'Local service' },
  note: {
    codex: 'Uses the ChatGPT account from "Sign in & subscriptions"; no key needed. The image model and thinking level are chosen by ChatGPT and cannot be set here.',
    compatible: 'Any relay or self-hosted service that speaks the OpenAI image API.',
    openai: 'Without a key here, the OpenAI key from "API keys" is used.',
    google: 'Without a key here, the Google key from "API keys" is used.',
    doubao: 'Without a key here, the Volcengine Ark key from "API keys" is used.',
    local: 'Services such as SD WebUI are detected automatically.'
  },
  signedIn: 'Signed in',
  notSignedIn: 'Not signed in',
  detected: 'Detected',
  notDetected: 'Not detected',
  keySaved: 'Key saved',
  keyElsewhere: 'Key found elsewhere',
  noKey: 'Not set',
  inUse: 'Default',
  complexity: 'Thinking level',
  complexityDesc: 'How much the model plans before drawing: low for small edits, high for dense text and complex layouts. Only applies to GPT Image 2.6 through OpenAI or a compatible endpoint; the default is high.',
  complexityDefault: 'Default',
  complexityLow: 'Low',
  complexityMedium: 'Medium',
  complexityHigh: 'High',
  baseUrl: 'Endpoint',
  model: 'Model',
  keyPlaceholder: 'Paste API key',
  keyReplace: 'Saved. Enter a new key to replace it',
  keyOverride: 'A key entered here takes priority',
  save: 'Save',
  clear: 'Clear',
  keySavedMsg: 'Key saved',
  keyClearedMsg: 'Key cleared',
  failed: 'Could not save'
}

export function imageText(lang: Lang): ImageText {
  return lang === 'en-US' ? en : zh
}
