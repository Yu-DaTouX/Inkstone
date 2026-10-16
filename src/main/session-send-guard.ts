/**
 * 同 cwd 发送 / 直执行前的只读复核。
 *
 * `RunnerRegistry.select()` 的同 cwd 冲突扫描只在「要创建 / 载入另一个实例」时执行；
 * 命中已有实例（hit）直接切视图返回。于是「同一物理 cwd 上已有一个后台忙碌实例，
 * 前台那个实例空闲」时，对前台实例发消息 / 直执行 bash 会绕过 select 的防线，
 * 在两个实例上同时写同一工作树。
 *
 * 这里只做一件只读判断：**除了发起者自己**，同一物理 cwd 是否还有别的忙碌实例。
 * 不停止别的会话、不把消息转投其它实例、不改变任何实例状态；不引入文件锁、租约、
 * 排队或新的任务状态机。
 *
 * ⚠️ 单次判断覆盖不了「双方 state 都还没推 running」的双发送竞态：两次发送在同一
 * 事件循环轮次里各自看到对方还是空闲，就都可能放行。为此同文件补了一组**同步**的
 * 执行入场 claim/token（见 `ExecuteAdmissionPort`）：Agent 在 send / steer / followUp /
 * runBash 入口同步 claim、真正入队前 confirm、失败 / 回合结束时 release。它仍然只是
 * 「同一物理 cwd 不同时开始执行」的保障，不是文件级全锁，也不宣称覆盖所有内部入口。
 */

/** 与注册表 `hasBusyCwd` 同义：除 `exceptRunId` 外，该 cwd 是否还有忙碌实例。 */
export type BusyCwdLookup = (cwd: string, exceptRunId?: string) => boolean

export interface ExecuteGuardInput {
  /** 发起动作的实例 id：复核时把自己从忙碌集合里排除。 */
  runnerId: string
  /** 该实例登记的物理 cwd。 */
  cwd: string
  /** 该实例此刻是否已经在跑（自己在写就不算「再开一个写者」，自己的插话 / 排队不拦）。 */
  selfBusy: boolean
}

export type ExecuteGuardResult = { ok: true } | { ok: false; error: string }

/**
 * 同步执行入场（admission claim）的相关窄接口。
 *
 * 为什么需要它：`guardSameCwdExecute` 是**状态查询**，不是同步预留。两个同 cwd 的
 * 空闲实例在 `agent_start` / running 状态到达前都能通过查询，随后同时向 pi 发出
 * 回合请求。这里把「这次执行要占用这颗 cwd」做成一个**同步** claim：先 claim 的
 * 那一个持有 token，后者拿不到就明确拒绝；`confirm` 在真正入队前再核一次，
 * `release` 在失败 / 取消 / 回合结束时归还。它仍然只是「同一物理 cwd 同时执行」的
 * 保障，不是文件级锁，也不新建任务状态机。
 */
export interface ExecuteAdmissionClaim {
  token: number
  /** 持有 claim 的运行实例 id。 */
  runId: string
  /** 持有 claim 时该实例的代次；过期或换代后旧 token 立即失效。 */
  generation: number
  /** 规范化前的登记 cwd（仅用于诊断，匹配用调用方传入的规范化键）。 */
  cwd: string
}

/** 由注册表按 runner 注入给 Agent 的执行入场口；没有注册表时缺省不发 claim。 */
export interface ExecuteAdmissionPort {
  claim(): { ok: true; token: number } | { ok: false; error: string }
  confirm(token: number): boolean
  release(token: number): void
}

export const SAME_CWD_ADMISSION_ERROR =
  '同一工作目录已有会话正在开始执行，本次不会同时放行。请等它跑完或停止它。'

/** claim 是否属于指定实例且同代次（旧代次 / 别的实例都不能清掉它）。 */
export function admissionClaimedBy(
  claim: ExecuteAdmissionClaim | null | undefined,
  id: string,
  generation: number | undefined
): boolean {
  return !!claim && claim.runId === id && claim.generation === generation
}

export const SAME_CWD_BUSY_ERROR =
  '同一工作目录还有另一个会话正在运行，这次不会开始执行：两个同时写文件的回合会互相覆盖。请等它跑完或停止它。'

/**
 * 判定这次「实际开始执行」是否与同 cwd 的另一个忙碌实例冲突。
 *
 * · 自己已经在跑：放行 —— 这是对**同一条**会话的插话 / 排队，不是第二个写者；
 * · 自己不忙、同 cwd 另有忙碌实例：拒绝并给出可读原因；
 * · 目标不存在或 cwd 为空：放行，交由后续既有检查处理。
 */
export function guardSameCwdExecute(
  input: ExecuteGuardInput | null,
  hasBusyCwd: BusyCwdLookup
): ExecuteGuardResult {
  if (!input?.runnerId || !input.cwd) return { ok: true }
  if (input.selfBusy) return { ok: true }
  return hasBusyCwd(input.cwd, input.runnerId) ? { ok: false, error: SAME_CWD_BUSY_ERROR } : { ok: true }
}
