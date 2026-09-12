/**
 * 对话区顶部/底部的几块「连续性」组件。
 *
 * 这里只做转发 —— 具体实现分别在 SessionHeader / EmptyStream 里。
 * （原来的「记忆审阅条 ReviewBar」已随记忆功能一起移除。）
 */
export { SessionHeader, SessionHeader as Continuity } from './SessionHeader'
export { EmptyStream } from './EmptyStream'
