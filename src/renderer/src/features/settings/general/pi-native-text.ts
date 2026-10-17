import type { Lang } from '../../../i18n'

export interface PiNativeText {
  effectNote: string
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
  effectNote: '这些选项写入 pi 的 settings.json，新开的会话运行实例生效。',
  loadFailed: '读取 pi 设置失败。',
  saveFailed: '保存 pi 设置失败。',
  retryCount: '最多重试',
  retryCountDesc: '一次请求出错后最多自动重试几次。',
  retryTimes: (n) => `${n} 次`,
  retryDelay: '首次重试等待',
  retryDelayDesc: '之后每次等待时间加倍。',
  seconds: (n) => `${n} 秒`,
  minutes: (n) => `${n} 分钟`,
  requests: '模型请求',
  idleTimeout: '连接空闲超时',
  idleTimeoutDesc: '等待响应头或下一段输出的最长间隔；本地模型停顿较久时可调长或不限制。',
  idleOff: '不限制',
  cacheWarming: '缓存预热',
  cacheWarmingDesc: '运行时保持提示缓存；「空闲时」在两轮之间也预热，只在划算时进行。',
  cacheOff: '关闭',
  cacheStreaming: '运行时',
  cacheIdle: '空闲时也预热',
  images: '图片',
  imagesAutoResize: '自动缩小大图',
  imagesAutoResizeDesc: '发给模型前把过大的图片缩到模型能接受的尺寸。',
  imagesBlock: '不向模型发送图片',
  imagesBlockDesc: '附件和工具读到的图片都不会发给模型。',
  thinking: '各模型默认思考档位',
  thinkingDesc: '切换到这些模型时自动换成对应档位；没列出的模型用全局默认。',
  thinkingEmpty: '还没有为单个模型设置档位。',
  thinkingModel: '模型',
  thinkingLevel: '思考档位',
  thinkingAdd: '添加',
  thinkingRemove: '移除',
  thinkingNoModels: '模型列表为空，连上模型服务后再设置。',
  trust: '项目默认信任',
  trustDesc: '没有扩展或已保存的信任决定时，pi 对新项目的处理方式。',
  trustAsk: '每次询问',
  trustAlways: '总是信任',
  trustNever: '从不信任',
  share: '会话分享',
  shareDesc: '「分享」上传会话的位置；自动时已登录 Radius 就用 Radius，否则用 GitHub Gist。',
  shareAuto: '自动',
  shareGist: 'GitHub Gist',
  shareRadius: 'Radius'
}

const EN: PiNativeText = {
  effectNote: 'These options are saved to pi settings.json and apply to newly started session runtimes.',
  loadFailed: 'Could not read pi settings.',
  saveFailed: 'Could not save pi settings.',
  retryCount: 'Max retries',
  retryCountDesc: 'How many times a failed request is retried automatically.',
  retryTimes: (n) => `${n}×`,
  retryDelay: 'First retry delay',
  retryDelayDesc: 'Each later retry waits twice as long.',
  seconds: (n) => `${n}s`,
  minutes: (n) => `${n} min`,
  requests: 'Model requests',
  idleTimeout: 'Connection idle timeout',
  idleTimeoutDesc: 'Longest gap while waiting for headers or the next chunk; raise or disable it for slow local models.',
  idleOff: 'No limit',
  cacheWarming: 'Cache warming',
  cacheWarmingDesc: 'Keeps the prompt cache warm while running; “Idle” also warms between turns when it pays off.',
  cacheOff: 'Off',
  cacheStreaming: 'While running',
  cacheIdle: 'Also when idle',
  images: 'Images',
  imagesAutoResize: 'Shrink large images',
  imagesAutoResizeDesc: 'Resize oversized images to a size the model accepts before sending.',
  imagesBlock: 'Never send images to the model',
  imagesBlockDesc: 'Attached images and images read by tools are withheld from the model.',
  thinking: 'Default thinking per model',
  thinkingDesc: 'Switching to one of these models applies its level; other models use the global default.',
  thinkingEmpty: 'No per-model levels yet.',
  thinkingModel: 'Model',
  thinkingLevel: 'Thinking level',
  thinkingAdd: 'Add',
  thinkingRemove: 'Remove',
  thinkingNoModels: 'The model list is empty; connect a provider first.',
  trust: 'Default project trust',
  trustDesc: 'What pi does for a new project when no extension or saved decision settles trust.',
  trustAsk: 'Ask each time',
  trustAlways: 'Always trust',
  trustNever: 'Never trust',
  share: 'Session sharing',
  shareDesc: 'Where Share uploads a session; Auto uses Radius when signed in, otherwise GitHub Gist.',
  shareAuto: 'Auto',
  shareGist: 'GitHub Gist',
  shareRadius: 'Radius'
}

export function piNativeText(lang: Lang): PiNativeText {
  return lang === 'en-US' ? EN : ZH
}
