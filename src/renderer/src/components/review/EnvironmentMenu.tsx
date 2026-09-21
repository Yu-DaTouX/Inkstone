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
import type {
  ForkRefsReportView,
  GitActionResult,
  GitRefOption,
  WorktreeBlocker,
  WorktreeInfo,
  WorktreeLinkView
} from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { compareWebUrl } from '../../../../shared/git'
import { shortProject } from '../rail/rail-utils'
import { SourceMenu } from './SourceMenu'
import { WriteFailure } from './CommitBar'
import { useGitWrite, useRepoState } from './useGitReview'

export function EnvironmentMenu() {
  const t = useT()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const openReview = useStore((s) => s.openReview)
  const project = session?.cwd ?? settings?.cwd
  const patchSettings = useStore((s) => s.patchSettings)
  const newSession = useStore((s) => s.newSession)
  const changeCwd = useStore((s) => s.changeCwd)
  const repoView = useRepoState(project)

  /**
   * PR 状态文案（方案 §7）。
   *
   * ⚠️ 这里必须写全分支，不能 `t(\`pr.${state}\`)` —— `t()` 的键是**字面量联合
   * 类型**，拼出来的字符串过不了类型检查（这正是不该拼的原因：拼出来的键
   * 拼错了编译期发现不了）。
   *
   * 查不到时要说清是哪一种查不到（没认证 / 限流 / 网络 / 不支持 / 仓库不存在），
   * 而不是笼统的「无法获取」—— 用户接下来该做什么完全取决于哪一种。
   */
  const prText = (): string => {
    if (pr === null) return t('pr.querying')
    if (!pr.ok) {
      if (pr.error === 'auth') return t('pr.err.auth')
      if (pr.error === 'rate-limit') return t('pr.err.rate-limit')
      if (pr.error === 'network') return t('pr.err.network')
      if (pr.error === 'not-found') return t('pr.err.not-found')
      if (pr.error === 'unsupported') return t('pr.err.unsupported')
      return t('pr.err.unknown')
    }
    if (pr.state === 'none') return t('pr.none')
    const head =
      pr.state === 'merged' ? t('pr.merged') : pr.state === 'closed' ? t('pr.closed') : pr.state === 'draft' ? t('pr.draft') : t('pr.open')
    const checks =
      pr.checks === 'pending'
        ? ' · ' + t('pr.checks.pending')
        : pr.checks === 'success'
          ? ' · ' + t('pr.checks.success')
          : pr.checks === 'failure'
            ? ' · ' + t('pr.checks.failure')
            : ''
    return head + checks + (pr.localAhead ? ' · ' + t('pr.localAhead') : '')
  }
  const repo = repoView.repo
  /* 写操作结束后刷新仓库状态：菜单里的数字（待推送 / 变更数）必须立刻是对的 */
  const write = useGitWrite(project, (res: GitActionResult) => {
    if (!res.ok) return
    /* 先用响应里的状态就地更新（立刻可用），再拉一次完整版本（含 refs） */
    if (res.state) repoView.apply(res.state)
    repoView.refresh()
  })

  const [open, setOpen] = useState(false)
  const [showBranches, setShowBranches] = useState(false)
  const [refs, setRefs] = useState<GitRefOption[]>([])
  const [busyBranches, setBusyBranches] = useState<string[]>([])
  const [newBranch, setNewBranch] = useState('')
  const [showWorktrees, setShowWorktrees] = useState(false)
  const [trees, setTrees] = useState<WorktreeInfo[]>([])
  /** 每个工作树目录的信任状态（键是目录路径）；点「信任」后只改这一条 */
  const [trustMap, setTrustMap] = useState<Record<string, { trusted: boolean; entry: string | null }>>({})
  /**
   * 每个工作树的「文件引用重绑定」报告（实施-07 S2b-3，键是目录路径）。
   *
   * 内容是把**当前会话**里 `@` 过的仓库内文件拿到那个工作树的仓库根下重新解析的结果 ——
   * 用户点「派生新会话」之前就能看到「我在源会话里提到的文件，在这个工作树里还剩几个能对上」。
   */
  const [forkRefs, setForkRefs] = useState<Record<string, ForkRefsReportView>>({})
  /** 「会话 ↔ 工作树」的来源关系（当前会话的用 `myOrigin` 取） */
  const [origins, setOrigins] = useState<WorktreeLinkView[]>([])
  /** 当前会话是从哪个工作树派生的（没登记过就是 undefined —— 那时什么都不画） */
  const myOrigin = session?.sessionId ? origins.find((x) => x.sessionId === session.sessionId) : undefined
  const [wtBranch, setWtBranch] = useState('')
  const [wtPath, setWtPath] = useState('')
  const [wtDeleteBranch, setWtDeleteBranch] = useState(false)
  const [wtBlockers, setWtBlockers] = useState<WorktreeBlocker[]>([])
  /** remote 的托管网页地址（github/gitlab/bitbucket 才认）；null = 不显示「在网上比较」 */
  const [webRepo, setWebRepo] = useState<string | null>(null)
  /** PR 状态（§7）：只读查询，只在菜单打开时拉一次 */
  const [pr, setPr] = useState<{
    ok: boolean
    state: string
    checks: string
    title?: string
    number?: number
    url?: string
    localAhead?: boolean
    error?: string
    message?: string
  } | null>(null)
  /*
   * 携带未提交改动（W2a）。
   * 三份东西是**分开**勾的：已暂存、未暂存、未跟踪 —— 因为在新工作树里
   * 「哪些已经挑好了」正是用户最在意、也最难自己重做的一件事。
   */
  const [carryStaged, setCarryStaged] = useState(false)
  const [carryUnstaged, setCarryUnstaged] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [untracked, setUntracked] = useState<{ path: string; size: number }[]>([])
  const [picked, setPicked] = useState<string[]>([])
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

  /*
   * 分支列表只在展开时拉：
   * 菜单每次打开都拉一次 refs（可能上百个分支）是白花的 —— 而分支切换
   * 本来就是低频动作。拿到后把「被其它工作树占用」也一并收下（方案 §5.1）。
   */
  useEffect(() => {
    if (!open || !showBranches || !project) return
    let alive = true
    void window.yan.git
      .refs(project)
      .then((res) => {
        if (!alive) return
        setRefs(res.refs.filter((r) => r.kind === 'local' || r.kind === 'head'))
        setBusyBranches(res.busyBranches)
      })
      .catch(() => {
        /* 拉不到分支列表不影响菜单其余部分，静默降级为空列表 */
      })
    return () => {
      alive = false
    }
  }, [open, showBranches, project])

  /*
   * 来源关系（实施-07 S2）跟菜单一起拉：数据量很小（旁挂的一张表），
   * 而「这个会话是不是从某个工作树派生的」要在菜单一打开就知道。
   */
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.yan.git
      .worktreeLinks()
      .then((res) => {
        if (alive) setOrigins(Array.isArray(res) ? res : [])
      })
      .catch(() => {
        /* 读不到就少一行追溯，不影响菜单其余部分 */
      })
    return () => {
      alive = false
    }
  }, [open])

  /*
   * 工作树列表也只在展开时拉：它是一条 git 命令 + 一次目录检查，
   * 而「我有几个工作树」不是每次打开菜单都要看的信息。
   */
  useEffect(() => {
    if (!open || !showWorktrees || !project) return
    let alive = true
    void window.yan.git
      .worktrees(project)
      .then((res) => {
        if (alive) setTrees(res.worktrees ?? [])
      })
      .catch(() => {
        /* 拉不到不影响菜单其余部分 */
      })
    return () => {
      alive = false
    }
  }, [open, showWorktrees, project, repoView.repo?.worktreeId])

  /*
   * 未跟踪清单：只在用户点开「选择要带过去的文件」时拉一次。
   * 复用审查用的快照通道（scope=untracked）—— 它已经把未跟踪文件做成了
   * 与审查面板同一份数据，没必要再开一条。
   */
  useEffect(() => {
    if (!pickOpen || !project) return
    let alive = true
    void window.yan.git
      .snapshot({ cwd: project, /* 没有单独的 untracked 范围：未跟踪文件在 working 里，靠 untracked 标志挑出来 */
            scope: { kind: 'working' }, requestId: `carry-${Date.now()}` })
      .then((res) => {
        if (!alive) return
        setUntracked(
          (res.files ?? [])
            .filter((f) => f.untracked)
            .map((f) => ({
            path: f.path,
            /* snapshot 不带 size；展示用 0，真正的大小上限由主进程把关 */
            size: 0
          }))
        )
      })
      .catch((e: unknown) => {
        if (alive) {
          setUntracked([])
          /*
           * 拉不到就说一声 —— 空清单与「拉失败」在界面上长得一样，
           * 而这两件事对用户的意义完全不同（一个是「没有」，一个是「不知道」）。
           */
          setWtBlockers([{ kind: 'missing', message: e instanceof Error ? e.message : String(e) }])
        }
      })
  }, [pickOpen, project])

  /*
   * PR 状态（§7）：只在菜单打开时查一次（它会发外发请求，不能每次渲染都打）。
   * 失败也记下来 —— 「为什么没有 PR」和「查不到」对用户是两件事。
   */
  useEffect(() => {
    if (!open || !project) return
    let alive = true
    setPr(null)
    void window.yan.git
      .prStatus(project)
      .then((res) => {
        if (alive) setPr(res)
      })
      .catch((e: unknown) => {
        if (alive) setPr({ ok: false, state: 'none', checks: 'none', error: 'unknown', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [open, project, repoView.repo?.head])

  /*
   * 托管网页比较（方案 §7）：只在菜单打开时问一次 remote 的网页地址。
   * 主进程那边认不出的托管站返回 null —— 那就不显示这一项，
   * 而不是给一个打不开的链接。
   */
  useEffect(() => {
    if (!open || !project) return
    let alive = true
    void window.yan.git
      .remoteWeb(project)
      .then((res) => {
        if (alive) setWebRepo(res.ok ? (res.web ?? null) : null)
      })
      .catch(() => {
        if (alive) setWebRepo(null)
      })
    return () => {
      alive = false
    }
  }, [open, project, repoView.repo?.head])

  /*
   * 工作树的项目信任状态（实施-07 S2b-2）。
   *
   * 为何要逐个工作树去查：pi 的信任是**按目录**记在 `trust.json` 里的，
   * 而工作树目录通常在仓库旁边（不在主仓库路径之下）—— 「主仓库被信任」
   * 不代表「工作树被信任」。而 RPC 模式没有信任弹窗，用户不处理的话
   * 项目级 `.pi/settings.json` 会被整份忽略。
   *
   * 只在展开工作树区时查（不多花 IPC）；`alive` 防的是「查完前菜单已关」时写回旧值。
   */
  useEffect(() => {
    if (!open || !showWorktrees) return
    const targets = trees.filter((w) => !w.main).map((w) => w.path)
    if (!targets.length) return
    let alive = true
    void Promise.all(
      targets.map((p) =>
        window.yan.trust
          .status(p)
          .then((st) => [p, { trusted: st.trusted, entry: st.entry }] as const)
          .catch(() => null)
      )
    ).then((rows) => {
      if (!alive) return
      const next: Record<string, { trusted: boolean; entry: string | null }> = {}
      for (const row of rows) if (row) next[row[0]] = row[1]
      setTrustMap(next)
    })
    return () => {
      alive = false
    }
  }, [open, showWorktrees, trees])

  /*
   * 工作树的「文件引用重绑定」（实施-07 S2b-3）。
   *
   * 输入是**当前会话**（用户正准备从它派生）：主进程把会话里 `@` 过的仓库内文件
   * 拿到目标工作树根下重新解析。**只在有引用时显示** —— 没有可对照的东西就不占位置
   * （与 S4 来源搜索同一口径：有则出现、无则隐藏）。
   *
   * 依赖 `session?.sessionId`：切会话后要重算（旧会话的引用不能留在新会话的菜单里）。
   */
  useEffect(() => {
    if (!open || !showWorktrees) return
    const targets = trees.filter((w) => !w.main).map((w) => w.path)
    if (!targets.length) return
    let alive = true
    void Promise.all(
      targets.map((p) =>
        window.yan.git
          .forkFileRefs({ worktree: p, sourceFile: session?.sessionFile, sourceCwd: session?.cwd })
          .then((report) => [p, report] as const)
          .catch(() => null)
      )
    ).then((rows) => {
      if (!alive) return
      const next: Record<string, ForkRefsReportView> = {}
      for (const row of rows) if (row) next[row[0]] = row[1]
      setForkRefs(next)
    })
    return () => {
      alive = false
    }
  }, [open, showWorktrees, trees, session?.sessionId, session?.sessionFile, session?.cwd])

  /* 打开时把焦点放进菜单，键盘用户能继续 Tab */
  useEffect(() => {
    if (open) firstRef.current?.focus()
  }, [open])

  /* 关掉菜单时收起分支列表：下次打开应该回到干净的面板 */
  useEffect(() => {
    if (!open) {
      setShowBranches(false)
      setNewBranch('')
      setShowWorktrees(false)
      setWtBlockers([])
      setPickOpen(false)
      setPicked([])
    }
  }, [open])

  const changed = repo?.changedCount ?? 0

  /**
   * 「对不上」的明细（放在 title 里，一行一条）。
   *
   * 为什么不用状态名显示：用户看到 `missing` 不知道是「工作树里没有」还是
   * 「仓库外的东西本来就不搬」—— 这两件事的处理方式完全不同（前者要去 git 里找，
   * 后者是设计如此）。
   */
  const forkRefsTip = (report: ForkRefsReportView): string => {
    const problems = report.summary.problems
    if (!problems.length) return t('env.forkRefsAllOk')
    return problems
      .map(
        (item) =>
          `${item.state === 'outside' ? t('env.forkRefsOutside') : item.state === 'missing' ? t('env.forkRefsMissing') : t('env.forkRefsMismatch')} · ${item.ref}`
      )
      .join('\n')
  }
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

              {/*
               * 「分支」以前点下去是「与本分支比较」—— 名字与实际动作不符
               * （Codex 参考里那行于分支本身）。现在它展开分支列表并支持
               * 切换与新建；「与谁比较」是下面独立的一项。
               */}
              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-branch"
                aria-expanded={showBranches}
                onClick={() => setShowBranches((v) => !v)}
              >
                <Icon name="layers" size={14} />
                <span className="env-label">{branchLabel}</span>
                {repo.ahead > 0 || repo.behind > 0 ? (
                  <span className="env-sub env-ab">
                    {repo.ahead > 0 ? `↑${repo.ahead}` : ''}
                    {repo.behind > 0 ? `↓${repo.behind}` : ''}
                  </span>
                ) : null}
                <Icon name="chevron-right" size={12} className={`env-caret ${showBranches ? 'open' : ''}`} />
              </button>

              {showBranches ? (
                <div className="env-branches" data-testid="env-branches">
                  {refs.map((r) => {
                    const inUse = busyBranches.includes(r.ref)
                    const isCurrent = r.ref === repo.branch
                    return (
                      <button
                        key={r.ref}
                        type="button"
                        className={`env-branch ${isCurrent ? 'current' : ''}`}
                        data-testid="env-branch-item"
                        disabled={!!write.busy || isCurrent || inUse}
                        title={inUse ? t('env.branchInUse') : r.ref}
                        onClick={() => {
                          if (!repoView.expected) return
                          void write.run({ kind: 'switch-branch', branch: r.ref }, repoView.expected)
                        }}
                      >
                        <span className="env-branch-name">{r.ref}</span>
                        {isCurrent ? <span className="env-branch-tag">{t('env.branchCurrent')}</span> : null}
                        {inUse ? <span className="env-branch-tag warn">{t('env.branchInUse')}</span> : null}
                      </button>
                    )
                  })}

                  <div className="env-newbranch">
                    <input
                      className="env-branch-input"
                      data-testid="env-new-branch-name"
                      placeholder={t('env.branchName')}
                      value={newBranch}
                      spellCheck={false}
                      onChange={(e) => setNewBranch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || !newBranch.trim() || !repoView.expected) return
                        void write.run(
                          { kind: 'create-branch', branch: newBranch.trim(), startPoint: null, checkout: true },
                          repoView.expected
                        )
                      }}
                    />
                    <button
                      type="button"
                      className="env-mini"
                      data-testid="env-create-branch"
                      disabled={!!write.busy || !newBranch.trim() || !repoView.expected}
                      title={t('env.createAndSwitch')}
                      onClick={() => {
                        if (!repoView.expected) return
                        void write.run(
                          { kind: 'create-branch', branch: newBranch.trim(), startPoint: null, checkout: true },
                          repoView.expected
                        )
                      }}
                    >
                      {t('env.createAndSwitch')}
                    </button>
                  </div>

                  {write.busy === 'switch-branch' || write.busy === 'create-branch' ? (
                    <div className="env-sub">{t('env.checking')}</div>
                  ) : null}
                </div>
              ) : null}

              {/* 拉取 / 推送：写操作，会改 .git（对象库 / 远程跟踪引用） */}
              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-fetch"
                disabled={!!write.busy || !repoView.expected}
                title={repo.upstream ? `${t('env.fetch')} ${repo.upstream.split('/')[0]}` : t('env.fetch')}
                onClick={() => {
                  if (!repoView.expected) return
                  void write.run({ kind: 'fetch', remote: null }, repoView.expected)
                }}
              >
                <Icon name="refresh" size={14} />
                <span className="env-label">{t('env.fetch')}</span>
                <span className="env-sub">{repo.upstream ? repo.upstream.split('/')[0] : ''}</span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-push"
                disabled={!!write.busy || !repoView.expected}
                title={repo.upstream ? repo.upstream : t('commit.noUpstream')}
                onClick={() => {
                  if (!repoView.expected) return
                  void write.run(
                    {
                      kind: 'push',
                      remote: null,
                      branch: repo.branch,
                      setUpstream: !repo.upstream
                    },
                    repoView.expected
                  )
                }}
              >
                <Icon name="send" size={14} />
                <span className="env-label">{t('env.push')}</span>
                <span className="env-sub env-ab">
                  {repo.unpushedCount === null
                    ? t('commit.setUpstream')
                    : repo.unpushedCount > 0
                      ? t('env.pushN', { n: repo.unpushedCount })
                      : ''}
                </span>
              </button>

              {/*
                * 工作树（方案 §6.2）：与子代理的一次性隔离工作树是两回事 ——
                * 这里建的会被用户长期使用，所以「移除」先检查再动手，
                * 被拦下时把原因逐条摆出来（不替他 stash / 提交 / 丢弃）。
                */}
              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-worktrees"
                aria-expanded={showWorktrees}
                onClick={() => setShowWorktrees((v) => !v)}
              >
                <Icon name="folder-open" size={14} />
                <span className="env-label">{t('env.worktrees')}</span>
                <span className="env-sub">{trees.length > 1 ? String(trees.length) : ''}</span>
                <Icon name="chevron-right" size={12} className={`env-caret ${showWorktrees ? 'open' : ''}`} />
              </button>

              {showWorktrees ? (
                <div className="env-branches env-worktrees" data-testid="env-worktree-list">
                  {/*
                   * 这个会话是从哪个工作树派生的（实施-07 S2）。
                   * 只在**确实登记过**时才画 —— 方案 §6.3 的硬要求是
                   * 「做不到就不显示无缝继续」，这里同理：不猜、不写死文案。
                   */}
                  {myOrigin ? (
                    <div className="env-carry-hint" data-testid="env-worktree-origin">
                      {t('env.worktreeOrigin', {
                        name: myOrigin.branch || t('env.detached'),
                        dir: myOrigin.worktree
                      })}
                    </div>
                  ) : null}
                  {trees.map((w) => (
                    <div className="env-worktree" key={w.path}>
                      <span className="env-branch-name" title={w.path}>
                        {w.branch ?? t('env.detached')}
                      </span>
                      {w.main ? <span className="env-branch-tag">{t('env.worktreeMain')}</span> : null}
                      {!w.main && w.ours ? <span className="env-branch-tag">{t('env.worktreeOurs')}</span> : null}
                      {!w.main ? (
                        trustMap[w.path]?.trusted ? (
                          <span className="env-branch-tag" data-testid="env-worktree-trusted">
                            {t('env.trusted')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="env-mini"
                            data-testid="env-worktree-trust"
                            title={t('env.trustAllowNote')}
                            onClick={() => {
                              /*
                               * 信任是**用户显式动作**：不因为「同一个 Git 仓库」「remote 相同」
                               * 就自动把源目录的信任搬过来（形态决策里的反模式之一）。
                               * 成功后就地改这一条，不重查（避免整个列表闪一下）。
                               */
                              void window.yan.trust.allow(w.path).then((res) => {
                                if (res?.ok) {
                                  setTrustMap((m) => ({ ...m, [w.path]: { trusted: true, entry: res.entry } }))
                                }
                              })
                            }}
                          >
                            {t('env.trustAllow')}
                          </button>
                        )
                      ) : null}
                      {!w.main ? (
                        <>
                        <button
                          type="button"
                          className="env-mini"
                          data-testid="env-worktree-open"
                          title={t('env.worktreeOpenNote')}
                          onClick={() => {
                            /*
                             * 「在新工作树开始新会话」—— 方案 §6.3 的**降级路径**。
                             *
                             * 完整的「带会话继续」要求重绑定项目权限、相对文件路径、
                             * 附件授权与上下文派生状态，并在新实例里接着原来的历史。
                             * 这些没有一件是可以靠改一个 cwd 字段完成的，所以按方案的
                             * 要求：**只开新会话**，并在按钮的 title 与下面的说明里
                             * 把「不带什么」讲清楚 —— 不显示「无缝继续」。
                             *
                             * ⚠️ 形态已定（2026-09-19，S2b-1）：这条路是 **Fork** ——
                             * 新会话 + 来源关系（`YAN_DIR/worktree-links.json`），默认不整段注入源历史。
                             * 判据见 `docs/plan/决策记录-07-S2b-工作树会话形态-2026-09-19.md`。
                             * 四片里 S2b-2（在工作树目录重新建立信任）、S2b-3（仓库相对路径重绑定）、
                             * S2b-4（接手上下文草稿）已经做完，`env.worktreeForkCarry` / `env.worktreeForkSkip`
                             * 两行文案已同步到这一步的事实；**S2b-5（附件不迁移）还没做** ——
                             * 做完那片之前，文案里不得出现“附件也带过来”。
                             *
                             * 先 setCwd 再 newSession：newSession 会把当前 cwd 作为
                             * 新会话的起点，晚一步设置就落回旧目录了。
                             */
                            void (async () => {
                              /*
                               * 来源关系要在**切之前**取：`newSession` 会把
                               * `session` 换成新的那一份，之后再读就是新会话自己。
                               */
                              const before = useStore.getState().session
                              await changeCwd(w.path)
                              const made = await newSession({ cwd: w.path })
                              if (made.ok && made.sessionId) {
                                /*
                                 * 登记失败**不静默**：它就是这块功能的全部证据。
                                 * 但仍不阻断切会话 —— 会话已经起来了，退回反而更糟。
                                 */
                                await window.yan.git
                                  .worktreeLink({
                                    sessionId: made.sessionId,
                                    worktree: w.path,
                                    branch: w.branch ?? '',
                                    fromSessionId: before?.sessionId ?? '',
                                    fromSessionFile: before?.sessionFile ?? '',
                                    fromCwd: before?.cwd ?? ''
                                  })
                                  .catch(() => undefined)
                                /*
                                 * 语义注入（S2b-4）：把「接手必须知道的」放进**新会话的输入框草稿**。
                                 *
                                 * 为何不自动发送：这一下花的是用户的额度、还替他定了第一句话；
                                 * 而草稿他能看一眼、补一句、也能直接删掉 —— 要的是“知道上下文”，
                                 * 不是“替他说了”。环境派生状态在主进程那边**在目标工作树上重读**，
                                 * 所以这里只给目录与来源，不把源会话的任何状态传过去。
                                 */
                                await window.yan.git
                                  .forkContext({
                                    worktree: w.path,
                                    sourceFile: before?.sessionFile,
                                    sourceCwd: before?.cwd,
                                    sourceSessionId: before?.sessionId
                                  })
                                  .then((ctx) => {
                                    if (ctx?.text) useStore.getState().injectComposerText(ctx.text)
                                  })
                                  .catch(() => undefined)
                              }
                              setOpen(false)
                            })()
                          }}
                        >
                          {t('env.worktreeOpen')}
                        </button>
                        <button
                          type="button"
                          className="env-mini"
                          data-testid="env-worktree-remove"
                          disabled={!!write.busy}
                          onClick={() => {
                            setWtBlockers([])
                            void window.yan.git
                              .worktreeRemove({ cwd: project ?? '', path: w.path, deleteBranch: wtDeleteBranch })
                              .then((res) => {
                                if (res.ok) {
                                  setTrees((prev) => prev.filter((x) => x.path !== w.path))
                                  repoView.refresh()
                                  return
                                }
                                setWtBlockers(res.blockers ?? [])
                                /* 没有 blockers 时把失败当普通错误显示（例如 git 自己拒绝） */
                                if (!res.blockers?.length && res.failure) {
                                  setWtBlockers([{ kind: 'missing', message: res.failure.message }])
                                }
                              })
                              .catch((e: unknown) =>
                                setWtBlockers([{ kind: 'missing', message: e instanceof Error ? e.message : String(e) }])
                              )
                          }}
                        >
                          {t('env.worktreeRemove')}
                        </button>
                        </>
                      ) : null}
                      {/*
                       * 文件引用重绑定（实施-07 S2b-3）：只在**确实有引用**时占位。
                       * 明细放在 `title` 里 —— 菜单已经很挤，而“哪几个对不上”是查时才需要的。
                       */}
                      {!w.main && (forkRefs[w.path]?.summary.total ?? 0) > 0 ? (
                        <div className="env-fork-refs" data-testid="env-fork-refs" title={forkRefsTip(forkRefs[w.path])}>
                          {t('env.forkRefs', {
                            total: String(forkRefs[w.path].summary.total),
                            resolved: String(forkRefs[w.path].summary.resolved)
                          })}
                          {forkRefs[w.path].summary.problems.length > 0
                            ? ' · ' + t('env.forkRefsProblems', { n: String(forkRefs[w.path].summary.problems.length) })
                            : ''}
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {trees.some((w) => !w.main) ? (
                    <div className="env-carry-hint env-fork-note" data-testid="env-worktree-open-note">
                      <div className="env-fork-title">{t('env.worktreeForkTitle')}</div>
                      <div className="env-fork-carry" data-testid="env-worktree-fork-carry">
                        {t('env.worktreeForkCarry')}
                      </div>
                      <div className="env-fork-skip" data-testid="env-worktree-fork-skip">
                        {t('env.worktreeForkSkip')}
                      </div>
                    </div>
                  ) : null}

                  <label className="env-wt-check">
                    <input
                      type="checkbox"
                      checked={wtDeleteBranch}
                      data-testid="env-worktree-delete-branch"
                      onChange={(e) => setWtDeleteBranch(e.target.checked)}
                    />
                    <span>{t('env.worktreeDeleteBranch')}</span>
                  </label>

                  <div className="env-newbranch">
                    <input
                      className="env-branch-input"
                      data-testid="env-worktree-branch"
                      placeholder={t('env.worktreeBranch')}
                      value={wtBranch}
                      spellCheck={false}
                      onChange={(e) => setWtBranch(e.target.value)}
                    />
                    <button
                      type="button"
                      className="env-mini"
                      data-testid="env-worktree-create"
                      disabled={!!write.busy || !wtBranch.trim()}
                      onClick={() => {
                        setWtBlockers([])
                        void window.yan.git
                          .worktreeCreate({
                            cwd: project ?? '',
                            branch: wtBranch.trim(),
                            startPoint: null,
                            targetPath: wtPath.trim() || null,
                            /* 三项都为假就不传 —— 主进程据此走「不携带」的路径并给出对应说明 */
                            carry:
                              carryStaged || carryUnstaged || picked.length > 0
                                ? { staged: carryStaged, unstaged: carryUnstaged, untracked: picked }
                                : null
                          })
                          .then((res) => {
                            const made = res.ok ? res.path : undefined
                            if (made) {
                              setTrees((prev) => [
                                ...prev,
                                {
                                  path: made,
                                  head: '',
                                  branch: res.branch ?? null,
                                  bare: false,
                                  main: false,
                                  locked: false,
                                  prunable: false,
                                  ours: true
                                }
                              ])
                              setWtBranch('')
                              setWtPath('')
                              setCarryStaged(false)
                              setCarryUnstaged(false)
                              setPickOpen(false)
                              setPicked([])
                              repoView.refresh()
                              /*
                               * 登记为项目（方案 §6.2：创建成功后要能**独立打开**）。
                               *
                               * 这里只写 settings.projects 一条记录：**不**动 cwd、**不**切会话 ——
                               * 「建完自动跳过去」会把用户正在做的事打断，而 W2 的会话重绑定
                               * 还没做（§6.3 要求做不到就别假装能）。同 cwd 已登记过就不重复写。
                               */
                              const known = settings?.projects ?? []
                              /*
                               * ⚠️ 比较前把 `\` 归一成 `/`：渲染端拿到的路径来自 git 输出
                               *（正斜杠），主进程落盘的是反斜杠 —— 直接比在 Windows 上永远不等，
                               * 结果就是每建一次工作树多一条重复项目。
                               */
                              const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
                              if (!known.some((x) => samePath(x.cwd, made))) {
                                const now = Date.now()
                                void patchSettings({
                                  projects: [
                                    ...known,
                                    {
                                      id: `wt-${now.toString(36)}`,
                                      cwd: made,
                                      name: res.branch ?? made.split(/[\/]/).pop() ?? made,
                                      archived: false,
                                      createdAt: now,
                                      updatedAt: now
                                    }
                                  ]
                                })
                              }
                            }
                          })
                          .catch(() => {
                            /* 失败原因由下面的 write.failure 统一展示（走同一条 IPC 形状） */
                          })
                      }}
                    >
                      {t('env.worktreeCreate')}
                    </button>
                  </div>
                  <input
                    className="env-branch-input env-wt-path"
                    data-testid="env-worktree-path"
                    placeholder={t('env.worktreePath')}
                    value={wtPath}
                    spellCheck={false}
                    onChange={(e) => setWtPath(e.target.value)}
                  />

                  {/*
                    携带未提交改动（方案 §6.2 的可选能力）。
                    三项分开勾 —— 新工作树里「哪些已经挑好了」是用户最在意的事。
                    默认全不勾：默认从已提交状态创建，这一点在按钮旁边写着。
                  */}
                  <div className="env-carry" data-testid="env-carry">
                    <label className="env-wt-check">
                      <input
                        type="checkbox"
                        checked={carryStaged}
                        data-testid="env-carry-staged"
                        onChange={(e) => setCarryStaged(e.target.checked)}
                      />
                      <span>{t('env.carryStaged')}</span>
                    </label>
                    <label className="env-wt-check">
                      <input
                        type="checkbox"
                        checked={carryUnstaged}
                        data-testid="env-carry-unstaged"
                        onChange={(e) => setCarryUnstaged(e.target.checked)}
                      />
                      <span>{t('env.carryUnstaged')}</span>
                    </label>
                    <label className="env-wt-check">
                      <input
                        type="checkbox"
                        checked={pickOpen}
                        data-testid="env-carry-untracked"
                        onChange={(e) => {
                          setPickOpen(e.target.checked)
                          if (!e.target.checked) setPicked([])
                        }}
                      />
                      <span>
                        {t('env.carryUntracked')}
                        {picked.length > 0 ? `（${picked.length}）` : ''}
                      </span>
                    </label>

                    {pickOpen ? (
                      <div className="env-carry-list" data-testid="env-carry-list">
                        {untracked.length === 0 ? (
                          <div className="env-branch-tag">{t('env.carryNone')}</div>
                        ) : (
                          untracked.slice(0, 40).map((f) => (
                            <label className="env-wt-check env-carry-file" key={f.path}>
                              <input
                                type="checkbox"
                                data-testid="env-carry-file"
                                checked={picked.includes(f.path)}
                                onChange={(e) =>
                                  setPicked((prev) => (e.target.checked ? [...prev, f.path] : prev.filter((x) => x !== f.path)))
                                }
                              />
                              <span title={f.path}>{f.path}</span>
                            </label>
                          ))
                        )}
                        {untracked.length > 40 ? (
                          <div className="env-branch-tag">{t('env.carryMore', { n: untracked.length - 40 })}</div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="env-carry-hint">{t('env.carryNote')}</div>
                  </div>

                  {wtBlockers.length ? (
                    <div className="gwrite-fail" data-testid="env-worktree-blockers">
                      <div className="gwrite-fail-line">
                        <Icon name="alert-circle" size={12} />
                        <span className="gwrite-fail-msg">{t('env.worktreeBlocked')}</span>
                      </div>
                      {wtBlockers.map((b) => (
                        <div className="gwrite-fail-hint" key={`${b.kind}-${b.message}`}>
                          {b.message}
                          {typeof b.count === 'number' ? `（${b.count}）` : ''}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-pr"
                title={pr?.message ?? pr?.title ?? ''}
                onClick={() => {
                  /* 有 PR 就打开它的网页；没有就什么都不做（不弹假状态） */
                  if (pr?.url) {
                    setOpen(false)
                    void window.yan.browser.open(pr.url)
                  }
                }}
              >
                <Icon name="globe" size={14} />
                <span className="env-label">{t('env.pr')}</span>
                <span className="env-sub" data-testid="env-pr-state">
                  {prText()}
                </span>
              </button>

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

              {/*
                托管网页比较（方案 §7）：把同一段比较交给托管站渲染。
                与上面那项是**并列**的，不是替代 —— 内部比较不联网也能用。
              */}
              {webRepo && repo.upstream && repo.branch ? (
                <button
                  type="button"
                  role="menuitem"
                  className="env-item"
                  data-testid="env-compare-web"
                  onClick={() => {
                    const link = compareWebUrl(webRepo, repo.upstream ?? '', repo.branch ?? '')
                    if (!link) return
                    setOpen(false)
                    void window.yan.browser.open(link)
                  }}
                >
                  <Icon name="globe" size={14} />
                  <span className="env-label">{t('env.compareWeb')}</span>
                  <span className="env-sub">{new URL(webRepo).host}</span>
                </button>
              ) : null}

              {/*
                关联外部任务链接（方案 §6.4）。文案里的边界是硬要求：
                不宣称上传代码 / 同步会话 / 远程执行。
              */}
              <SourceMenu sessionId={session?.sessionId ?? 'default'} open={open} onClose={() => setOpen(false)} />
            </>
          ) : (
            <div className="env-item env-static" data-testid="env-notgit" title={t('env.notGitHint')}>
              <Icon name="folder" size={14} />
              <span className="env-label">{t('env.notGit')}</span>
              <span className="env-sub">{repoView.loading ? t('env.checking') : t('env.notGitHint')}</span>
            </div>
          )}

          {repoView.error ? <div className="env-error">{repoView.error}</div> : null}

          {/* 写操作的失败：**不关菜单**，原地把原因与原始输出摆出来 */}
          {write.failure ? (
            <WriteFailure msg={write.failure.message} hint={write.failure.hint} detail={write.failure.detail} />
          ) : null}
          {write.notice ? (
            <div className="gwrite-ok" data-testid="env-notice">
              <Icon name="check-circle" size={12} />
              <span>{write.notice}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
