/**
 * v3 浏览器面板自己的短文案。
 *
 * 与 `app/v3-text.ts` 同一约定：不往共享 i18n JSON 里加键（那两份文件是
 * 共享热点，v3 尚未定稿）。已经存在的通用键（地址、后退、前进、刷新、加载、
 * 出错、标签页）继续用 `useT()`，这里只放 v3 新增的归属提示。
 */
import type { Lang } from '../../i18n'

export interface BrowserText {
  /** active=false：先切到这条会话才能用浏览器 */
  inactive: string
  /** 浏览器被另一条会话占着 */
  foreignOwner: string
  /** 主进程里还没有打开的原生网页 */
  notOpen: string
  /** 明确的用户入口：点它才调用宿主打开，不自动开 */
  open: string
  /** 打开进行中：按钮禁用，避免连点并发导航同一个浏览器 */
  opening: string
  tabLabel: string
  viewportLabel: string
}

const ZH: BrowserText = {
  inactive: '先激活这条会话，才能使用内置浏览器。',
  foreignOwner: '内置浏览器当前归另一条会话；切回去或在这条会话里重新打开。',
  notOpen: '内置浏览器还没有打开。',
  open: '打开浏览器',
  opening: '正在打开…',
  tabLabel: '内置浏览器标签页',
  viewportLabel: '网页显示区域'
}

const EN: BrowserText = {
  inactive: 'Activate this conversation before using the built-in browser.',
  foreignOwner: 'The built-in browser belongs to another conversation; switch back or reopen it here.',
  notOpen: 'The built-in browser is not open.',
  open: 'Open browser',
  opening: 'Opening…',
  tabLabel: 'Built-in browser tabs',
  viewportLabel: 'Web page area'
}

export function browserText(lang: Lang): BrowserText {
  return lang === 'en-US' ? EN : ZH
}
