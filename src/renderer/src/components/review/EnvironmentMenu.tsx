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
  GitActionResult,
  GitRefOption,
  WorktreeBlocker,
  WorktreeInfo
} from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { compareWebUrl } from '../../../../shared/git'
import { shortProject } from '../rail/rail-utils'
import { SourceLinks } from './SourceLinks'
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
  const [wtBranch, setWtBranch] = useState('')
  const [wtPath, setWtPath] = useState('')
  const [wtDeleteBranch, setWtDeleteBranch] = useState(false)
  const [wtBlockers, setWtBlockers] = useState<WorktreeBlocker[]>([])
  /** remote 的托管网页地址（github/gitlab/bitbucket 才认）；null = 不显示「在网上比较」 */
  const [webRepo, setWebRepo] = useState<string | null>(null)
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
                  {trees.map((w) => (
                    <div className="env-worktree" key={w.path}>
                      <span className="env-branch-name" title={w.path}>
                        {w.branch ?? t('env.detached')}
                      </span>
                      {w.main ? <span className="env-branch-tag">{t('env.worktreeMain')}</span> : null}
                      {!w.main && w.ours ? <span className="env-branch-tag">{t('env.worktreeOurs')}</span> : null}
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
                             * 把「不带走什么」讲清楚 —— 不显示「无缝继续」。
                             *
                             * 先 setCwd 再 newSession：newSession 会把当前 cwd 作为
                             * 新会话的起点，晚一步设置就落回旧目录了。
                             */
                            void (async () => {
                              await changeCwd(w.path)
                              await newSession({ cwd: w.path })
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
                    </div>
                  ))}

                  {trees.some((w) => !w.main) ? (
                    <div className="env-carry-hint" data-testid="env-worktree-open-note">
                      {t('env.worktreeOpenNote')}
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
              <SourceLinks sessionId={session?.sessionId ?? 'default'} open={open} />
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
