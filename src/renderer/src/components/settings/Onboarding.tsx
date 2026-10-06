import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { BrandMark } from '../shell/BrandMark'
import { useStore } from '../../state/store'
import type { ToolchainStatus } from '../../../../shared/ipc'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button, IconButton } from '../ui'

/**
 * 首次使用引导。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 * 这个应用有**两个非显然的前提**，不告诉用户就会卡在第一步：
 *
 *   ① **必须已安装 pi**（`npm i -g @earendil-works/pi-coding-agent`）。
 *      我们是 pi 的客户端，不是替代品 —— 不装 pi 就完全用不了。
 *   ② **必须配一个模型凭证**。可以是 API key，也可以是订阅制
 *      （ChatGPT Plus / Claude Pro 等，但要先在终端跑一次 `pi /login`）。
 *
 * 这两件事在界面上都有体现（标题栏连接状态、设置里的接入页），
 * 但**新用户不知道要去哪里看**。所以首次启动时直接告诉他。
 *
 * ── 设计取舍 ──
 * · 做成**一页卡片**而不是多步向导：只有两条要检查的事，
 *   分步反而要点四次「下一步」。
 * · 每一行都能**当场验证**（不是「请确保…」这种空话）：
 *   pi 装没装 → 显示版本号；凭证有没有 → 显示已就绪数量。
 * · 可以**跳过**，且之后能从「关于」页重新打开 —— 不强制。
 * · 只在**首次启动且检测到问题时**自动弹出。已经能用的用户不该被打扰
 *   （用 localStorage 记住「看过了」）。
 */
export function Onboarding({ onClose }: { onClose: () => void }) {
  const t = useT()
  const piInfo = useStore((s) => s.piInfo)
  const session = useStore((s) => s.session)
  const conn = useStore((s) => s.conn)
  const models = useStore((s) => s.models)
  const openSettings = useStore((s) => s.openSettings)

  /* 卡片本身就是一层模态：Esc 关闭 + 焦点圈定 + 通知主进程暂停快捷键 */
  const card = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(card, true, isTop)

  const [ready, setReady] = useState<{ n: number; total: number; fromEnv: number } | null>(null)

  /**
   * 重新检测凭证。
   *
   * 为什么单独抽成函数并暴露重测按钮（用户要求）：
   *   首次启动时用户可能**已经在本地配好了 key**（写在 auth.json 里，
   *   或者跑在环境变量里）—— 引导页不应该拿一个一次性快照就把第 2 步
   *   判成未完成。用户去接线页填完 key 回来、或自己改完环境变量，
   *   需要能**就地重测**，而不用重启应用。
   *
   * 用浅查（不启 pi 进程）：auth.json 与环境变量都是本地文件/内存读，
   * 毫秒级；deep 查会逐项问 pi，那是设置页里点「重新检测」才做的事。
   */
  const detect = useCallback(async () => {
    try {
      const list = await window.yan.authProviders(false)
      const okList = list.filter((x) => x.status === 'ready')
      setReady({
        n: okList.length,
        total: list.length,
        fromEnv: okList.filter((x) => x.source === 'env').length
      })
    } catch {
      setReady(null)
    }
  }, [])

  useEffect(() => {
    void detect()
  }, [detect])

  const piOk = !!piInfo?.version
  const connOk = conn === 'ready'
  /* pi 拿不到模型时会报一个名为 unknown 的占位，那不算「可用」 */
  const modelOk = models.length > 0 && !!session?.model && session.model.id !== 'unknown'
  const authOk = (ready?.n ?? 0) > 0

  /* 新装的 Windows 设备常缺 Git for Windows：没有 bash，命令行工具与改动审阅都用不了 */
  const [tools, setTools] = useState<ToolchainStatus | null>(null)
  const detectTools = useCallback(async () => {
    try {
      setTools(await window.yan.toolchainStatus())
    } catch {
      setTools(null)
    }
  }, [])
  useEffect(() => {
    void detectTools()
  }, [detectTools])
  const toolsOk = !tools || (tools.bash.ok && tools.git.ok)

  /**
   * 一条检查项。
   *
   * ⚠️ 状态类名带 `ob-` 前缀：以前叫 `ok` / `todo`，后者撞上 chat.css 里
   *    旧任务面板遗留的全局 `.todo { grid-template-columns: 12px 1fr }`，
   *    把这一行改成了两列 grid —— 操作区的两个按钮被挤成 21px 宽、
   *    文字截断并压在说明文字上（N20）。前缀化的类名不会误命中通用选择器。
   */
  const Row = ({
    ok,
    title,
    desc,
    action,
    testId
  }: {
    ok: boolean
    title: string
    desc: React.ReactNode
    action?: React.ReactNode
    testId: string
  }) => (
    <div className={`ob-row ${ok ? 'ob-ok' : 'ob-todo'}`} data-testid={testId} data-ok={ok ? '1' : '0'}>
      <span className="ob-check" aria-hidden>
        {ok ? <Icon name="check" size={12} /> : null}
      </span>
      <div className="ob-row-main">
        <div className="ob-row-title">{title}</div>
        <div className="ob-row-desc">{desc}</div>
      </div>
      {action ? <div className="ob-row-act">{action}</div> : null}
    </div>
  )

  return (
    <div className="ob-scrim" role="dialog" aria-modal="true" aria-label={t('ob.title')}>
      <div className="ob-card" ref={card} data-testid="onboarding">
        <div className="ob-head">
          <span className="ob-logo">
            <BrandMark size={22} decorative />
          </span>
          <div>
            <div className="ob-title">{t('ob.title')}</div>
            <div className="ob-sub">{t('ob.sub')}</div>
          </div>
          <span className="spacer" />
          <IconButton icon="close" iconSize={14} className="ob-x" label={t('ob.skip')} data-testid="ob-close" onClick={onClose} />
        </div>

        <div className="ob-body">
          {/* ① pi 本体 */}
          <Row
            testId="ob-pi"
            ok={piOk}
            title={t('ob.piTitle')}
            desc={
              piOk ? (
                <>
                  {t('ob.piFound')} <code>{piInfo?.version}</code>
                  <span className="ob-src">
                    {' · '}
                    {piInfo?.bundled ? t('ob.piSourceBundled') : t('ob.piSourceExternal')}
                  </span>
                </>
              ) : (
                <>
                  {t('ob.piMissing')} <code>npm i -g @earendil-works/pi-coding-agent</code>
                </>
              )
            }
          />

          {/* ② 模型接入 */}
          <Row
            testId="ob-auth"
            ok={authOk}
            title={t('ob.authTitle')}
            desc={
              authOk ? (
                <>
                  {t('ob.authOk', { n: ready?.n ?? 0 })}
                  {/* 用环境变量配的要说明白：那种情况在设置里「移除」不了 */}
                  {ready && ready.fromEnv > 0 ? (
                    <span data-testid="ob-auth-env">
                      {' '}
                      · {t('ob.authEnv', { n: ready.fromEnv })}
                    </span>
                  ) : null}
                </>
              ) : (
                t('ob.authMissing')
              )
            }
            action={
              <>
                {/* 重测：用户去填完 key 回来、或改了环境变量，不用重启应用 */}
                <Button className="ob-btn" onClick={() => void detect()} data-testid="ob-recheck-auth">
                  {t('ob.recheck')}
                </Button>
                <Button variant="primary" className="ob-btn" onClick={() => openSettings('auth')} data-testid="ob-open-auth">
                  {t('ob.goAuth')}
                </Button>
              </>
            }
          />

          {/* ③ 命令行工具（bash / git）；检测不到状态时不显示，避免误报 */}
          {tools ? (
            <Row
              testId="ob-tools"
              ok={toolsOk}
              title={t('ob.toolsTitle')}
              desc={toolsOk ? t('ob.toolsOk') : [tools.bash, tools.git].filter((tool) => !tool.ok && tool.hint).map((tool) => tool.hint).join(' ')}
              action={
                <Button className="ob-btn" onClick={() => void detectTools()} data-testid="ob-recheck-tools">
                  {t('ob.recheck')}
                </Button>
              }
            />
          ) : null}

          {/* ④ 连通性 */}
          <Row
            testId="ob-conn"
            ok={connOk}
            title={t('ob.connTitle')}
            desc={connOk ? t('ob.connOk') : t('ob.connMissing')}
          />

          {/* ⑤ 模型列表（能列出模型 = pi 跑起来了） */}
          <Row
            testId="ob-models"
            ok={modelOk}
            title={t('ob.modelTitle')}
            desc={modelOk ? t('ob.modelOk', { n: models.length, name: session?.model?.name ?? '' }) : t('ob.modelMissing')}
            action={
              <Button className="ob-btn" onClick={() => openSettings('status')}>
                {t('ob.goStatus')}
              </Button>
            }
          />

          {/* 两条「知道就好」的键位 */}
          <div className="ob-tips">
            <div className="ob-tip">
              <Icon name="message-dots" size={12} />
              <span>{t('ob.tip1')}</span>
            </div>
            <div className="ob-tip">
              <Icon name="terminal" size={12} />
              <span>{t('ob.tip2')}</span>
            </div>
          </div>
        </div>

        <div className="ob-foot">
          <span className="ob-foot-note">{t('ob.footNote')}</span>
          <span className="spacer" />
          <Button variant="primary" className="ob-btn" onClick={onClose} data-testid="ob-done">
            {t('ob.start')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 是否该自动弹出引导（首次启动 + 有问题） */
const SEEN_KEY = 'yan.onboarded'

export function shouldAutoOnboard(state: {
  conn: string
  piInfo: { version?: string } | null
  models: unknown[]
}): boolean {
  try {
    if (localStorage.getItem(SEEN_KEY) === '1') return false
  } catch {
    // file:// 下可能读不到 —— 那就当没看过（宁可多提示一次）
  }
  /*
   * 只在**确实有问题**时弹：
   *   · pi 没找到（version 探测失败）→ 一定弹
   *   · 连不上 pi 或没有可用模型 → 弹
   * 一切正常就不打扰（用户可能只是换了台机器，但环境已就绪）。
   */
  if (!state.piInfo?.version) return true
  if (state.conn !== 'ready') return true
  if (state.models.length === 0) return true
  return false
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* 忽略 */
  }
}
