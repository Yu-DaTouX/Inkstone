import type { Lang } from '../../../i18n'
import type { DrawPen } from './draw-model'

export interface DrawPromptEntry {
  name: string
  frame: string
  width: number
  height: number
  texts: readonly string[]
  time?: number | null
}

export interface DrawText {
  lang: Lang
  title: string
  penLabel: string
  pens: Record<DrawPen, string>
  colorLabel: string
  colors: Record<string, string>
  undo: string
  redo: string
  clear: string
  send: string
  sending: string
  sent: string
  sendEmpty: string
  sendFailed: string
  sendBlocked: string
  framesLabel: string
  count: (value: number) => string
  empty: string
  hint: string
  labelInput: string
  labelPlaceholder: string
  prompt: (entry: DrawPromptEntry) => string
}

const ZH: DrawText = {
  lang: 'zh-CN',
  title: '标注',
  penLabel: '笔形',
  pens: {
    free: '画笔',
    rect: '矩形',
    ellipse: '椭圆',
    arrow: '箭头',
    text: '文字'
  },
  colorLabel: '颜色',
  colors: { accent: '蓝色', fail: '红色', ok: '绿色', ask: '琥珀色', stall: '橙色' },
  undo: '撤销',
  redo: '重做',
  clear: '清空当前画框',
  send: '发送到聊天',
  sending: '正在截图…',
  sent: '已发送',
  sendEmpty: '画框里还没有标注。',
  sendFailed: '截图或合成失败，标注没有发送。',
  sendBlocked: '聊天输入框没有准备好，标注没有发送。',
  framesLabel: '画框',
  count: (value) => `${value} 处标注`,
  empty: '在画框上拖动圈画，或用文字工具点一下再输入。',
  hint: '空格 + 拖动平移画布，Esc 取消正在画的形状，Ctrl/Cmd+Z 撤销',
  labelInput: '标注文字',
  labelPlaceholder: '输入文字，回车确认',
  prompt: (entry) => {
    const at = typeof entry.time === 'number' ? `，时间点 ${entry.time.toFixed(2)} 秒` : ''
    const head = `请按截图里的标注修改 ${entry.name}（${entry.frame} ${entry.width}×${entry.height}${at}）：`
    if (!entry.texts.length) return head
    return [head, ...entry.texts.map((text) => `- ${text}`)].join('\n')
  }
}

const EN: DrawText = {
  lang: 'en-US',
  title: 'Annotate',
  penLabel: 'Pen',
  pens: {
    free: 'Freehand',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    arrow: 'Arrow',
    text: 'Text'
  },
  colorLabel: 'Color',
  colors: { accent: 'Blue', fail: 'Red', ok: 'Green', ask: 'Amber', stall: 'Orange' },
  undo: 'Undo',
  redo: 'Redo',
  clear: 'Clear this frame',
  send: 'Send to chat',
  sending: 'Capturing…',
  sent: 'Sent',
  sendEmpty: 'Nothing drawn in the frames yet.',
  sendFailed: 'Could not capture or compose the screenshot, so nothing was sent.',
  sendBlocked: 'The chat input is not ready, so the annotations were not sent.',
  framesLabel: 'Frames',
  count: (value) => (value === 1 ? '1 annotation' : `${value} annotations`),
  empty: 'Drag on a frame to draw, or click with the text pen and type.',
  hint: 'Space + drag pans the canvas, Esc cancels the current shape, Ctrl/Cmd+Z undoes',
  labelInput: 'Annotation text',
  labelPlaceholder: 'Type text, Enter to confirm',
  prompt: (entry) => {
    const at = typeof entry.time === 'number' ? `, at ${entry.time.toFixed(2)}s` : ''
    const head = `Please revise ${entry.name} following the annotations in the screenshot (${entry.frame} ${entry.width}×${entry.height}${at}):`
    if (!entry.texts.length) return head
    return [head, ...entry.texts.map((text) => `- ${text}`)].join('\n')
  }
}

export function drawText(lang: Lang): DrawText {
  return lang === 'en-US' ? EN : ZH
}
