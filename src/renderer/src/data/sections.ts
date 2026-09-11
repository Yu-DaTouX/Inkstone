/**
 * 右栏记忆面板的分区定义。
 *
 * 前四块是「记忆」本身，状态沉底 —— 顺序本身就是信息架构：
 * 先看它记得什么，最后才看它花了多少。
 */
import type { MessageKey } from '../i18n'

export const MEMORY_SECTION_IDS = [
  'soul',
  'about',
  'impressions',
  'people',
  'projects',
  'status'
] as const

export type MemorySectionId = (typeof MEMORY_SECTION_IDS)[number]

export interface MemorySectionDef {
  id: MemorySectionId
  icon: string
  titleKey: MessageKey
  /** 未确认的区块默认展开（要用户处理），其它默认按常规 */
  defaultOpen: boolean
  /** 加载时从哪取数据；soul/status 走特殊组件 */
  source: 'soul' | 'about' | 'impressions' | 'people' | 'projects' | 'status'
}

export const MEMORY_SECTIONS: MemorySectionDef[] = [
  { id: 'soul', icon: 'shield-check', titleKey: 'mem.identity', defaultOpen: true, source: 'soul' },
  { id: 'about', icon: 'check-circle', titleKey: 'mem.aboutYou', defaultOpen: true, source: 'about' },
  {
    id: 'impressions',
    icon: 'sparkles',
    titleKey: 'mem.impressions',
    defaultOpen: true,
    source: 'impressions'
  },
  { id: 'people', icon: 'chat-round', titleKey: 'mem.people', defaultOpen: true, source: 'people' },
  { id: 'projects', icon: 'folder', titleKey: 'mem.projects', defaultOpen: false, source: 'projects' },
  { id: 'status', icon: 'activity', titleKey: 'mem.state', defaultOpen: false, source: 'status' }
]

/** 头像一样的符号：不同来源用不同颜色条（见 app.css 的 .memrow .bar） */
export const TOPIC_OPTIONS = ['about', 'people', 'projects'] as const
export type Topic = (typeof TOPIC_OPTIONS)[number]

export const TOPIC_LABEL_KEY: Record<Topic, MessageKey> = {
  about: 'mem.topicAbout',
  people: 'mem.topicPeople',
  projects: 'mem.topicProjects'
}
