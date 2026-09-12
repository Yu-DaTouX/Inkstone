/**
 * 分支树（用户要求）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用户原话
 * ══════════════════════════════════════════════════════════════════
 *   「分支功能的更改：当用户在某个会话中按下分支，则在左栏的会话中增加
 *     一个分支树，可以点击打开即可看到对话的分支详情」
 *
 * ── 为什么是这样一棵「只有分支点」的树 ──
 * pi 的会话是一棵 append-only 的树，实测一个真实会话 **2000+ 节点、12 个分支点**。
 * 把 2000 个节点画出来既没法看也没法滚。所以：
 *   · 只显示**分支点**（有 ≥2 条岔路的地方）
 *   · 每个岔路用它**第一句用户话**当标签（人认的是这句话，不是 entryId）
 *   · 标出**哪一条是当前活动的**（否则不知道自己站在哪）
 *   · 分支点之间的普通消息只显示个数（「… N 条消息之后」）
 *
 * ── 一个重要事实：不能「切换」分支 ──
 * pi 的 RPC **没有** navigate_tree（47 个命令里没有）——
 * 所以这里能做的是「**从这里分支**」（fork，创建新分支）与「查看」，
 * 不能点一下就跳到另一条已存在的分支。按钮文案如实写。
 *
 * 数据在主进程已经裁好（main/session-tree.ts），这里只管画。
 */
import { useEffect, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { forkAt } from '../../lib/fork'
import type { SessionTree } from '../../../../shared/ipc'

export function BranchTree({ sessionPath }: { sessionPath: string }) {
  const t = useT()
  const [tree, setTree] = useState<SessionTree | null>(null)
  const [openPoint, setOpenPoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.yan
      .sessionTree()
      .then((r) => {
        if (alive) setTree(r)
      })
      .catch(() => {
        /* 拉不到就不显示分支（不能因此把左栏弄崩） */
      })
    return () => {
      alive = false
    }
  }, [sessionPath])

  if (!tree) return <div className="bt-dim">{t('branch.loading')}</div>
  if (tree.points === 0) return <div className="bt-dim" data-testid="branch-none">{t('branch.none')}</div>

  return (
    <div className="btree" data-testid="branch-tree">
      <div className="bt-sum">
        {t('branch.summary', { points: tree.points, total: tree.total })}
      </div>

      {tree.branches.map((bp, i) => {
        const open = openPoint === bp.id
        return (
          <div key={bp.id} className="bt-point" data-testid={`branch-point-${i}`}>
            <button
              className={`bt-head ${open ? 'open' : ''}`}
              onClick={() => setOpenPoint(open ? null : bp.id)}
              aria-expanded={open}
              data-testid={`branch-head-${i}`}
            >
              <Icon name="chevron-right" size={12} className="chev" />
              <span className="bt-idx">#{i + 1}</span>
              {/*
               * 「N 条消息之后」——分支点在会话里的位置。
               * 数量大的时候人靠这个判断「这是早期还是最近的分叉」。
               */}
              <span className="bt-after">
                {bp.afterMessages > 0 ? t('branch.after', { n: bp.afterMessages }) : t('branch.atStart')}
              </span>
              <span className="spacer" />
              <span className="bt-count" data-testid={`branch-alts-${i}`}>
                {t('branch.alts', { n: bp.alternatives.length })}
              </span>
            </button>

            {open ? (
              <div className="bt-body">
                {bp.alternatives.map((a, j) => (
                  <div
                    key={a.entryId}
                    className={`bt-alt ${a.active ? 'active' : ''}`}
                    data-testid={`branch-alt-${i}-${j}`}
                    data-active={a.active ? '1' : '0'}
                  >
                    <span className="bt-dot" aria-hidden />
                    <div className="bt-alt-main">
                      <div className="bt-alt-text" title={a.text}>
                        {a.text || t('branch.noText')}
                      </div>
                      <div className="bt-alt-meta">
                        <span>{t('branch.size', { n: a.size })}</span>
                        {a.active ? (
                          <span className="bt-now" data-testid={`branch-active-${i}-${j}`}>
                            {t('branch.current')}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {/*
                     * 只能「从这里分支」——协议没有「切到那条分支」的命令，
                     * 所以不做那个按钮（不做假功能）。
                     */}
                    <button
                      className="bt-fork"
                      disabled={busy}
                      title={t('branch.forkHint')}
                      data-testid={`branch-fork-${i}-${j}`}
                      onClick={() => {
                        setBusy(true)
                        void forkAt(a.entryId).finally(() => setBusy(false))
                      }}
                    >
                      {t('branch.fork')}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
