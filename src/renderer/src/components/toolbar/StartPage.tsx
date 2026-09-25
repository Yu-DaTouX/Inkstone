import { Icon } from '../../icons/Icon'

/**
 * 右栏默认「开始」页（实施-11 H-3b）。
 *
 * 这里只显示浏览入口；审查、终端、文件与工作信息集中在标签栏的＋菜单。
 * 工具页仍承载上下文与运行信息，首页不重复铺一列入口卡片。
 */
export type StartEntry = 'review' | 'browser' | 'file' | 'tools' | 'terminal'

export function StartPage({ onOpen }: { onOpen: (entry: StartEntry) => void }) {
  return (
    <div className="rp-start" data-testid="right-start-page">
      <div className="rp-start-group" role="group" aria-label="新标签页">
        <Icon name="globe" size={16} className="rp-start-globe" />
        <button type="button" className="rp-start-open" data-testid="start-browser" onClick={() => onOpen('browser')}>
          开始浏览
        </button>
        <span className="rp-start-hint">打开浏览器后输入 URL，或用上方＋选择工具</span>
      </div>
    </div>
  )
}
