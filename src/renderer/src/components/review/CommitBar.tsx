/**
 * 审查面板里的写操作区（方案 §5.2 / §5.3，G2）。
 *
 * 三块内容：
 *   · **暂存列**（`ReviewPanel.tsx` 的 `.rcard-stage`）：每个文件行的「暂存 / 取消暂存」
 *   · **全部暂存 / 全部取消暂存**：面板头部的批量按钮
 *   · **提交区**（本文件）：说明输入 + 提交 / 提交并推送 + 结果
 *
 * ── 为什么提交区是「常驻底部」而不是弹窗 ──
 * 提交前要核对的东西（改了哪些文件、说明写得对不对）就在上面的 diff 里，
 * 弹窗会把它们全挡掉。所以它固定在面板底部，默认只有一行输入框；要写长
 * 说明就自己拉高（CSS 的 max-height 过渡），不占 diff 的地方。
 *
 * ── 一件刻意不做的事：没有「丢弃改动」──
 * 方案 §5.1 明确「不覆盖用户改动」，§5.2 的动作清单里也只有暂存 / 取消暂存 /
 * 提交。这个按钮一旦出现，误点的代价是不可恢复的 —— 要加它得先有「哪些
 * 文件会被覆盖」的完整预览与二次确认设计，那是独立的一项。
 */
import { useEffect, useState } from 'react'
import type { GitActionExpected, GitActionResult, GitReviewSnapshot } from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useGitWrite } from './useGitReview'

/** 失败提示：分类 + 原文。原文可以折叠，但它才是排查的第一现场 */
export function WriteFailure({ msg, hint, detail }: { msg: string; hint?: string; detail?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="gwrite-fail" data-testid="git-failure" role="alert">
      <div className="gwrite-fail-line">
        <Icon name="alert-circle" size={12} />
        <span className="gwrite-fail-msg">{msg}</span>
      </div>
      {hint ? <div className="gwrite-fail-hint">{hint}</div> : null}
      {detail ? (
        <>
          <button
            type="button"
            className="gwrite-fail-more"
            data-testid="git-failure-detail-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t('git.hideRaw') : t('git.showRaw')}
          </button>
          {open ? <pre className="gwrite-fail-raw">{detail}</pre> : null}
        </>
      ) : null}
    </div>
  )
}

export function CommitBar({
  snapshot,
  cwd,
  onDone
}: {
  snapshot: GitReviewSnapshot | null
  cwd: string | undefined
  /** 写操作结束后刷新快照（patch 缓存由调用方一并清掉） */
  onDone: (res: GitActionResult) => void
}) {
  const t = useT()
  const [message, setMessage] = useState('')
  const [withPush, setWithPush] = useState(false)
  const [setUpstream, setSetUpstream] = useState(false)
  const write = useGitWrite(cwd, onDone)

  const repo = snapshot?.repo ?? null
  const expected = snapshot?.expected
  const staged = repo?.stagedCount ?? 0
  const busy = !!write.busy
  const disabled = busy || !expected || !staged || !message.trim()

  /* 提交成功后清空输入框 —— 留着会让用户以为没提交（或又点一次） */
  useEffect(() => {
    if (write.notice && !write.failure) setMessage('')
  }, [write.notice, write.failure])

  const submit = async (push: boolean): Promise<void> => {
    if (!expected) return
    const res = await write.run({ kind: 'commit', message }, expected)
    /* 提交成功、推送失败时**保留提交**，重试只推送（方案 §5.3） */
    if (!push || !res.ok) return
    /*
     * 推送要用的版本是**提交之后**的：提交已经改了 HEAD，继续用提交前的那份
     * 会被主进程正确地拒成 stale（那正是复核在起作用的证据）。
     * 另外两个字段（index / status 摘要）在 push 这一级**不会被读** ——
     * push 只复核 HEAD（见 main/git-actions.ts 的 GuardLevel 说明），
     * 这里原样带上是为了让请求形状完整。
     */
    const after: GitActionExpected = {
      head: res.headAfter ?? res.state?.head ?? expected.head,
      indexDigest: expected.indexDigest,
      statusDigest: expected.statusDigest
    }
    await write.run(
      {
        kind: 'push',
        remote: null,
        branch: res.state?.branch ?? repo?.branch ?? null,
        /* 没上游时必须设上游，否则推送必然报 no-upstream */
        setUpstream: setUpstream || !res.state?.upstream
      },
      after
    )
  }

  return (
    <div className="commit" data-testid="commit-bar">
      <div className="commit-row">
        <textarea
          className="commit-msg"
          data-testid="commit-message"
          placeholder={t('commit.placeholder')}
          value={message}
          rows={1}
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            /* Ctrl/Cmd+Enter 直接提交：写说明时手不用离开键盘 */
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !disabled) {
              e.preventDefault()
              void submit(withPush)
            }
          }}
        />
        <button
          type="button"
          className="commit-btn primary"
          data-testid="commit-submit"
          disabled={disabled}
          onClick={() => void submit(withPush)}
        >
          {busy && write.busy === 'commit' ? t('commit.running') : withPush ? t('commit.submitAndPush') : t('commit.submit')}
        </button>
        <button
          type="button"
          className={`commit-push ${withPush ? 'on' : ''}`}
          data-testid="commit-push-toggle"
          title={t('commit.pushHint')}
          aria-pressed={withPush}
          onClick={() => setWithPush((v) => !v)}
        >
          <Icon name={withPush ? 'check-circle' : 'send'} size={12} />
        </button>
      </div>

      <div className="commit-meta">
        <span className="commit-target" data-testid="commit-target">
          {repo?.name ?? ''}
          {repo?.branch ? ` · ${repo.branch}` : repo?.detached ? ` · ${t('env.detached')}` : ''}
        </span>
        <span className="spacer" />
        {staged > 0 ? (
          <span className="commit-staged" data-testid="commit-staged">
            {t('commit.stagedFiles', { n: staged })}
          </span>
        ) : (
          <span className="commit-none" data-testid="commit-nostaged">
            {t('commit.nothingStaged')}
          </span>
        )}
        {withPush ? (
          <>
            <label className="commit-up" title={t('commit.setUpstreamHint')}>
              <input
                type="checkbox"
                checked={setUpstream || !repo?.upstream}
                disabled={!repo?.upstream ? false : setUpstream}
                onChange={(e) => setSetUpstream(e.target.checked)}
                data-testid="commit-set-upstream"
              />
              <span>{t('commit.setUpstream')}</span>
            </label>
            {!repo?.upstream ? <span className="commit-hint">{t('commit.noUpstream')}</span> : null}
          </>
        ) : null}
      </div>

      {write.failure ? (
        <WriteFailure msg={write.failure.message} hint={write.failure.hint} detail={write.failure.detail} />
      ) : null}
      {write.notice ? (
        <div className="gwrite-ok" data-testid="git-notice">
          <Icon name="check-circle" size={12} />
          <span>{write.notice}</span>
        </div>
      ) : null}
    </div>
  )
}
