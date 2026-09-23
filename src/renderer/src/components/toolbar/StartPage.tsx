import { Icon, type IconName } from '../../icons/Icon'

/**
 * 右栏默认「开始」页（实施-11 H-3b）。
 *
 * 这里只负责**导航**：像入口清单，不承载磁贴、不新造第二个工具栏。
 * 工具页（承载上下文/任务等磁贴）是另一个固定页，由标签行切换。
 * 终端入口要等 H-11 真的可用；未接入时不放一个永久灰按钮（能力说明里标注即可）。
 */
export type StartEntry = 'review' | 'browser' | 'file' | 'tools' | 'terminal'

const ENTRIES: { id: StartEntry; icon: IconName; label: string; desc: string }[] = [
  { id: 'review', icon: 'check-circle', label: '审查', desc: '查看当前工作区的改动' },
  { id: 'browser', icon: 'globe', label: '浏览器', desc: '在内置网页里打开页面' },
  { id: 'file', icon: 'folder', label: '文件', desc: '浏览并预览工作区文件' },
  { id: 'terminal', icon: 'activity', label: '终端', desc: '在工作目录里开一个交互终端' },
  { id: 'tools', icon: 'layers', label: '工具', desc: '上下文、任务与运行信息' }
]

export function StartPage({ onOpen }: { onOpen: (entry: StartEntry) => void }) {
  return (
    <div className="rp-start" data-testid="right-start-page">
      <div className="rp-start-group" role="group" aria-label="开始">
        <div className="rp-start-title">开始</div>
        {ENTRIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="rp-start-item"
            data-testid={`start-${entry.id}`}
            onClick={() => onOpen(entry.id)}
          >
            <span className="rp-start-icon" aria-hidden="true">
              <Icon name={entry.icon} size={16} />
            </span>
            <span className="rp-start-text">
              <span className="rp-start-label">{entry.label}</span>
              <span className="rp-start-desc">{entry.desc}</span>
            </span>
            <span className="rp-start-go" aria-hidden="true">
              <Icon name="chevron-right" size={14} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
