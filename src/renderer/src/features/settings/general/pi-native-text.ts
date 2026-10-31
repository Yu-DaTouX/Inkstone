import type { Lang } from '../../../i18n'

export interface PiNativeText {
  effectNote: string
  sessionEffectNote: string
  loadFailed: string
  saveFailed: string
  retryCount: string
  retryCountDesc: string
  retryTimes: (n: number) => string
  retryDelay: string
  retryDelayDesc: string
  seconds: (n: number) => string
  minutes: (n: number) => string
  requests: string
  idleTimeout: string
  idleTimeoutDesc: string
  idleOff: string
  cacheWarming: string
  cacheWarmingDesc: string
  cacheOff: string
  cacheStreaming: string
  cacheIdle: string
  images: string
  imagesAutoResize: string
  imagesAutoResizeDesc: string
  imagesBlock: string
  imagesBlockDesc: string
  thinking: string
  thinkingDesc: string
  thinkingEmpty: string
  thinkingModel: string
  thinkingLevel: string
  thinkingAdd: string
  thinkingRemove: string
  thinkingNoModels: string
  trust: string
  trustDesc: string
  trustAsk: string
  trustAlways: string
  trustNever: string
  share: string
  shareDesc: string
  shareAuto: string
  shareGist: string
  shareRadius: string
}

const ZH: PiNativeText = {
  effectNote: '新会话生效。',
  sessionEffectNote: '重试、超时、缓存预热与图片选项对新会话生效。',
  loadFailed: '读取 pi 设置失败。',
  saveFailed: '保存 pi 设置失败。',
  retryCount: '最多重试',
  retryCountDesc: '请求出错后最多自动重试几次。',
  retryTimes: (n) => `${n} 次`,
  retryDelay: '首次重试等待',
  retryDelayDesc: '之后每次等待时间加倍。',
  seconds: (n) => `${n} 秒`,
  minutes: (n) => `${n} 分钟`,
  requests: '模型请求',
  idleTimeout: '连接空闲超时',
  idleTimeoutDesc: '等待响应的最长间隔；本地模型可调长。',
  idleOff: '不限制',
  cacheWarming: '缓存预热',
  cacheWarmingDesc: '保持提示缓存；「空闲时」在两轮间也预热。',
  cacheOff: '关闭',
  cacheStreaming: '运行时',
  cacheIdle: '空闲时也预热',
  images: '图片',
  imagesAutoResize: '自动缩小大图',
  imagesAutoResizeDesc: '发送前缩小过大的图片。',
  imagesBlock: '不向模型发送图片',
  imagesBlockDesc: '附件与工具读到的图片都不发给模型。',
  thinking: '各模型默认思考档位',
  thinkingDesc: '切到这些模型时自动换档；其余用全局默认。',
  thinkingEmpty: '还没有为单个模型设置档位。',
  thinkingModel: '模型',
  thinkingLevel: '思考档位',
  thinkingAdd: '添加',
  thinkingRemove: '移除',
  thinkingNoModels: '模型列表为空，连上模型服务后再设置。',
  trust: '项目默认信任',
  trustDesc: '新项目没有信任决定时怎么处理。',
  trustAsk: '每次询问',
  trustAlways: '总是信任',
  trustNever: '从不信任',
  share: '会话分享',
  shareDesc: '「分享」上传会话的位置；自动时优先 Radius，否则 Gist。',
  shareAuto: '自动',
  shareGist: 'GitHub Gist',
  shareRadius: 'Radius'
}

const EN: PiNativeText = {
  effectNote: 'Applies to new sessions.',
  sessionEffectNote: 'Retry, timeout, cache and image options apply to new sessions.',
  loadFailed: 'Could not read pi settings.',
  saveFailed: 'Could not save pi settings.',
  retryCount: 'Max retries',
  retryCountDesc: 'Retries after a failed request.',
  retryTimes: (n) => `${n}×`,
  retryDelay: 'First retry delay',
  retryDelayDesc: 'Each later retry waits twice as long.',
  seconds: (n) => `${n}s`,
  minutes: (n) => `${n} min`,
  requests: 'Model requests',
  idleTimeout: 'Connection idle timeout',
  idleTimeoutDesc: 'Longest wait for a response; raise for slow local models.',
  idleOff: 'No limit',
  cacheWarming: 'Cache warming',
  cacheWarmingDesc: 'Keeps the prompt cache warm; Idle also warms between turns.',
  cacheOff: 'Off',
  cacheStreaming: 'While running',
  cacheIdle: 'Also when idle',
  images: 'Images',
  imagesAutoResize: 'Shrink large images',
  imagesAutoResizeDesc: 'Resize oversized images before sending.',
  imagesBlock: 'Never send images to the model',
  imagesBlockDesc: 'Withhold attached and tool-read images.',
  thinking: 'Default thinking per model',
  thinkingDesc: 'Applied when switching to these models; others use the global default.',
  thinkingEmpty: 'No per-model levels yet.',
  thinkingModel: 'Model',
  thinkingLevel: 'Thinking level',
  thinkingAdd: 'Add',
  thinkingRemove: 'Remove',
  thinkingNoModels: 'The model list is empty; connect a provider first.',
  trust: 'Default project trust',
  trustDesc: 'How new projects are treated without a saved decision.',
  trustAsk: 'Ask each time',
  trustAlways: 'Always trust',
  trustNever: 'Never trust',
  share: 'Session sharing',
  shareDesc: 'Where Share uploads; Auto prefers Radius, else Gist.',
  shareAuto: 'Auto',
  shareGist: 'GitHub Gist',
  shareRadius: 'Radius'
}

export function piNativeText(lang: Lang): PiNativeText {
  return lang === 'en-US' ? EN : ZH
}
