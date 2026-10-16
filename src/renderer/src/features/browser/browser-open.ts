/**
 * v3 内置浏览器的打开编排（纯逻辑，可注入 mock 桥单测）。
 *
 * 为什么单独成模块：打开跨了一次 `window.yan.browser.open` 的 await，这期间
 * 用户会切会话、连点、或别的地方并发点开。规则要可测，而且 store 的 v2 入口
 * 不能大改：
 *
 *   · 全局只有一个原生 `WebContentsView`。资源已经记在**别的会话**名下时
 *     （无论是它的网页正开着，还是它正在打开途中、`state.open` 还是 false），
 *     这里都不抢占、不并发导航，明确安全失败；
 *   · 带 target 的每次打开登记一个代次；await 回来后发现已被更新的打开意图
 *     取代，就连状态都不写（旧回包不能盖新意图）；
 *   · 即便代次没过期，也要再核对「当前视图仍是发起会话」——切走了就只记录
 *     全局真实状态，不抢当前视图的显隐（旧 Promise 不能把旧 view 重新 show 出来）。
 *
 * 显隐一律由 store 里既有的 `applyBrowserVisibility` / `shouldShowBrowser` 协调，
 * 本模块只决定「要不要调用 reveal」，绝不直接 `setVisible`。
 */
import type { BrowserState } from '../../../../shared/ipc'

/** claim 失败的原因：资源已开着，还是正被别人打开。 */
export type BrowserOpenBlockedReason = 'foreign-owner' | 'opening-elsewhere'

/**
 * v3 面板传入的发起目标。
 *
 * 只有 v3 会传：它带面板的 `WorkspaceOwner.key`，让 store 的 `openBrowser` 能在
 * await 回来后复核「当前视图还是不是发起这条」。v2 入口不传，行为不变。
 */
export interface BrowserOpenTarget {
  key: string
}

/**
 * 打开编排依赖的宿主接口。
 *
 * 全部注入：单测用内存桥替换，生产由 store 绑定既有 `window.yan.browser` /
 * `resource-owners` / `applyBrowserVisibility`。
 */
export interface BrowserOpenPorts {
  /** 正式桥：`window.yan.browser.open`。 */
  open: (url?: string) => Promise<BrowserState>
  /**
   * 当前视图对应的会话键（每次调用现算）。
   *
   * 只有带 target 的打开才用它复核：它是**活的当前视图**，不是发起时的快照。
   */
  currentOwnerKey: () => string
  /** `resourceOwner('browser')`。 */
  resourceOwner: () => string | undefined
  /** `claimResource('browser', owner)`，返回实际主人（已有主人时不覆盖）。 */
  claimResource: (owner: string) => string
  /** `releaseResource('browser')`。 */
  releaseResource: () => void
  /** 主进程里是否已经有打开的原生网页。 */
  isBrowserOpen: () => boolean
  /** 写回主进程返回的浏览器状态。 */
  setBrowserState: (state: BrowserState) => void
  /** 本次打开成为当前显示意图：展开右栏 + 交给显隐协调器。 */
  reveal: () => void
  /** 安全失败（不抢占别人的资源，也不并发导航）。 */
  blocked: (reason: BrowserOpenBlockedReason) => void
  /** 宿主打开失败。 */
  failed: (message: string) => void
}

export interface BrowserOpenInput {
  /** 发起打开的会话键（v3 传 `WorkspaceOwner.key`）。 */
  owner: string
  url?: string
  /**
   * 是否启用代次 / 当前视图守卫。
   *
   * v3 通过 store 的 optional target 传 true；v2 入口不传，行为与改动前一致。
   */
  guard: boolean
}

/**
 * 打开编排器。
 *
 * 代次是**实例状态**：同一把会话键连点两次时，第二次取代第一次，旧回包作废。
 * 只有 `guard=true` 的调用才参与代次，v2 调用互不影响。
 */
export class BrowserOpener {
  private generation = 0
  private latest: { generation: number; key: string } | null = null

  constructor(private readonly ports: BrowserOpenPorts) {}

  async open(input: BrowserOpenInput): Promise<void> {
    const { owner, url, guard } = input
    const previousOwner = this.ports.resourceOwner()
    const held = this.ports.claimResource(owner)

    if (guard && held !== owner) {
      /*
       * 资源记在别的会话名下：已打开（foreign-owner）或正在打开途中
       * （opening-elsewhere，此时 `state.open` 还是 false）。两种都不能抢占 ——
       * 否则 B 会在 A 尚在打开时抢走这个全局唯一的浏览器。
       */
      this.ports.blocked(this.ports.isBrowserOpen() ? 'foreign-owner' : 'opening-elsewhere')
      return
    }

    const generation = guard ? ++this.generation : 0
    if (guard) this.latest = { generation, key: owner }

    try {
      const state = await this.ports.open(url)
      /* 被更新的打开意图取代：连状态都不写，避免旧回包盖掉新意图。 */
      if (guard && !this.isCurrent(generation, owner)) return
      this.ports.setBrowserState(state)
      /* 用户已经切走：记录全局真实状态，但不抢当前视图的显隐。 */
      if (guard && this.ports.currentOwnerKey() !== owner) return
      this.ports.reveal()
    } catch (error) {
      /*
       * 失败保留可重试：只有本次仍是最后意图、且资源是我们刚认领的，才释放；
       * 不误清别人或更新意图的认领。
       */
      const claimFresh = previousOwner === undefined && !this.ports.isBrowserOpen() && this.ports.resourceOwner() === owner
      if (claimFresh && (!guard || this.isCurrent(generation, owner))) this.ports.releaseResource()
      this.ports.failed(error instanceof Error ? error.message : String(error))
    }
  }

  private isCurrent(generation: number, key: string): boolean {
    return this.latest !== null && this.latest.generation === generation && this.latest.key === key
  }
}
