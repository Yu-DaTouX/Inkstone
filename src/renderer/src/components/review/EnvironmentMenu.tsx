/**
 * 环境菜单（方案 §3.1）。
 *
 * 入口是会话头部原来那个「项目胶囊」—— 它此前只是个静态标签，现在变成
 * 「我现在跑在什么环境里」的入口：变更、工作目录、当前分支、Pull Request、
 * 比较分支。形态参考 Codex 的环境信息菜单（用户提供的截图）。
 *
 * ── 三条刻意的取舍 ──
 * 1. **只放已经能用的动作**。方案 §14 明确「不展示可执行入口而不实现」：
 *    提交 / 推送 / 切换分支属于 G2，这里就不摆按钮 —— 摆一个按下去
 *    说「还没做」的按钮比不摆更糟。分支那一项因此做成「与其比较」
 *    而不是「切换」（比较是 G1 已经有的只读能力）。
 * 2. 每个数字都来自真实查询；拿不到就写「无法获取 Pull Request 状态」
 *    这样的明确说明，不伪造状态（gh 没装就是没装）。
 * 3. 图标复用现有的 reicon 集（没有 git-compare 这类专用图标）：
 *    变更 = history、本地 = folder、分支 = layers、PR = globe、
 *    比较 = search。**不复用同一个图标承担两层含义**（DESIGN §2.7）。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { shortProject } from '../rail/rail-utils'
import { useRepoState } from './useGitReview'

export function EnvironmentMenu() {
  const t = useT()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const openReview = useStore((s) => s.openReview)
  const project = session?.cwd ?? settings?.cwd
  const repoView = useRepoState(project)
  const repo = repoView.repo

  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)

  /* 点外面 / Escape 关闭。捕获阶段监听 keydown，避免被内层组件先吃掉 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  /* 打开时把焦点放进菜单，键盘用户能继续 Tab */
  useEffect(() => {
    if (open) firstRef.current?.focus()
  }, [open])

  const changed = repo?.changedCount ?? 0
  const branchLabel = repo?.detached
    ? t('env.detached')
    : repo?.unborn
      ? t('env.noCommit')
      : (repo?.branch ?? t('env.detached'))

  return (
    <div className={`env-wrap ${open ? 'open' : ''}`} ref={wrapRef} data-testid="env-wrap">
      <button
        type="button"
        className={`shead-proj env-btn ${project ? '' : 'none'}`}
        title={project ?? t('header.noProject')}
        data-testid="session-project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="shead-proj-ico" aria-hidden="true">{project ? '▸' : '·'}</span>
        <span className="shead-proj-name">{project ? shortProject(project) : t('header.noProject')}</span>
        <Icon name="chevron-right" size={12} className="chev env-caret" />
      </button>

      {open ? (
        <div className="env-menu" role="menu" data-testid="env-menu" aria-label={t('env.title')}>
          <div className="env-head">{t('env.title')}</div>

          {repo ? (
            <>
              <button
                type="button"
                role="menuitem"
                ref={firstRef}
                className="env-item"
                data-testid="env-changes"
                onClick={() => {
                  setOpen(false)
                  openReview({ kind: 'working' })
                }}
              >
                <Icon name="history" size={14} />
                <span className="env-label">{t('env.changes')}</span>
                <span className="env-count" data-testid="env-changes-count">
                  {changed === 0 ? (
                    <span className="env-none">{t('env.noChanges')}</span>
                  ) : (
                    <>
                      <span className="env-num">{changed}</span>
                      {repo.untrackedCount > 0 ? (
                        <span className="env-num env-untracked" title={t('env.untracked')}>
                          +{repo.untrackedCount}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </button>

              {/*
               * 「本地」不是导航项，而是**当前执行环境**：显示工作目录，
               * 并给出方案 §6.1 要求的两个动作（打开文件夹 / 复制路径）。
               * 之前它点下去是打开审查 —— 名字与实际动作对不上。
               */}
              <div className="env-item env-static" data-testid="env-local" title={project ?? ''}>
                <Icon name="folder" size={14} />
                <span className="env-label">{t('env.local')}</span>
                <span className="env-sub" title={project ?? ''}>
                  {project ? shortProject(project) : ''}
                </span>
                <button
                  type="button"
                  className="env-mini"
                  data-testid="env-open-folder"
                  title={t('env.openFolder')}
                  onClick={() => {
                    setOpen(false)
                    if (project) void window.yan.openPath(project)
                  }}
                >
                  {t('env.open')}
                </button>
                <button
                  type="button"
                  className="env-mini"
                  data-testid="env-copy-path"
                  title={t('env.copyPath')}
                  onClick={() => {
                    setOpen(false)
                    if (project) void navigator.clipboard?.writeText(project)
                  }}
                >
                  {t('env.copy')}
                </button>
              </div>

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-branch"
                onClick={() => {
                  setOpen(false)
                  /*
                   * 「与本分支比较」：target 是当前 HEAD，base 先给一个能用的
                   * 默认（upstream 优先，没有就上一个提交）。真正的 base 由
                   * 审查面板里的下拉换 —— 这里不替用户猜死。
                   */
                  openReview({ kind: 'range', base: repo.upstream ?? 'HEAD~1', target: repo.branch ?? 'HEAD' })
                }}
              >
                <Icon name="layers" size={14} />
                <span className="env-label">{branchLabel}</span>
                {repo.ahead > 0 || repo.behind > 0 ? (
                  <span className="env-sub env-ab">
                    {repo.ahead > 0 ? `↑${repo.ahead}` : ''}
                    {repo.behind > 0 ? `↓${repo.behind}` : ''}
                  </span>
                ) : null}
              </button>

              <div className="env-item env-static" data-testid="env-pr" title={t('env.prUnavailable')}>
                <Icon name="globe" size={14} />
                <span className="env-label">{t('env.pr')}</span>
                <span className="env-sub" title={t('env.prUnavailable')}>
                  {t('env.prUnavailable')}
                </span>
              </div>

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-compare"
                onClick={() => {
                  setOpen(false)
                  const target = repo.branch ?? 'HEAD'
                  const base = repo.upstream ?? 'HEAD~1'
                  openReview({ kind: 'range', base, target })
                }}
              >
                <Icon name="search" size={14} />
                <span className="env-label">{t('env.compare')}</span>
                <span className="env-sub" title={repo.upstream && repo.branch ? `${repo.upstream} → ${repo.branch}` : ''}>
                  {repo.upstream && repo.branch ? `${repo.upstream} → ${repo.branch}` : t('env.chooseBase')}
                </span>
              </button>
            </>
          ) : (
            <div className="env-item env-static" data-testid="env-notgit" title={t('env.notGitHint')}>
              <Icon name="folder" size={14} />
              <span className="env-label">{t('env.notGit')}</span>
              <span className="env-sub">{repoView.loading ? t('env.checking') : t('env.notGitHint')}</span>
            </div>
          )}

          {repoView.error ? <div className="env-error">{repoView.error}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
