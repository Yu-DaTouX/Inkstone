/**
 * 项目信任、工作树 Fork 与读数类的 IPC 适配（`yan:trust:*`、`yan:fork:*`、`yan:compactionInfo`、`yan:providerQuota`）。
 *
 * 信任句柄故意不读设置：调用方必须把目录传进来（设置的读-改-写不是原子的）。
 */
import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { compactionInfo } from '../compaction'
import { allowTrust, trustStatus } from '../project-trust'
import { forkContext, forkFileRefs } from '../fork-rebind-service'
import { providerQuota } from '../quota'
import type { HandoffPackage } from '../../shared/handoff'
import { normalizeSessionFileKey } from '../work-mode-service'
import type { HandoffStore } from '../handoff-service'

export interface WorkspaceIpcDeps {
  handoffs: HandoffStore
}

export function registerWorkspaceIpc(ipc: IpcRegistrar, deps: WorkspaceIpcDeps): void {
  const { rawHandle } = ipc
  const { handoffs } = deps
  /* ---- 自动压缩设置（只读 pi 的 settings.json）---- */
  rawHandle('yan:compactionInfo', async (_e, win: unknown) => {
    const s = await getSettings()
    return compactionInfo(s.cwd, typeof win === 'number' ? win : 0)
  })

  /*
   * 项目信任（实施-07 S2b-2）。
   *
   * 为何只给「读」与「用户显式信任一个目录」两件事：
   * 工作树目录通常在仓库旁边（不在主仓库路径之下），所以「源目录被信任」不等于
   * 「工作树目录被信任」—— 而 RPC 模式没有信任弹窗，用户不改 trust.json 就永远
   * 看不到项目级设置生效。**不做自动继承**（形态决策里的反模式之一）。
   *
   * ⚠️ 这两个句柄**故意不读 settings**（调用方必须把目录传进来）：
   *   `getSettings()` 与 `patchSettings()` 的读-改-写不是原子的（见 settings.ts 的
   *   `writeQueue` 注释），多一个“顺手读一下设置”的调用方就多一次交错机会 ——
   *   2026-09-19 真实踩到：这两个句柄原本会 fallback 到 `settings.cwd`，
   *   于是工作树创建后「登记为项目」的写入被并发读盘缓存盖掉（项目从列表里消失）。
   */
  rawHandle('yan:trust:status', async (_e, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir) return { cwd: '', trusted: false, entry: null }
    return trustStatus(dir)
  })
  rawHandle('yan:trust:allow', async (_e, cwd: unknown) => {
    const dir = typeof cwd === 'string' ? cwd.trim() : ''
    if (!dir) return { ok: false, entry: '', error: '缺少目录' }
    return allowTrust(dir)
  })

  /*
   * 工作树 Fork 的文件引用重绑定（实施-07 S2b-3）。
   *
   * 渲然端给「目标工作树 + 当前会话文件与 cwd」，主进程把源会话里 `@` 过的
   * 仓库内文件拿到目标仓库根下重新解析 —— 一律用**仓库相对路径**，
   * 仓库外的路径报 `outside`（不迁移）。这里的 `explicitRefs` 只给测试与将来的
   * 显式交接用（写死一份引用比伪造会话文件诚实）。
   */
  rawHandle('yan:fork:fileRefs', async (_e, arg: unknown) =>
    forkFileRefs((arg ?? {}) as Parameters<typeof forkFileRefs>[0])
  )

  /*
   * Fork 的语义注入正文（实施-07 S2b-4）。
   *
   * 渲染端在「派生新会话」成功后调它，拿到的文本作为**输入框草稿**注入（不自动发送）：
   * 用户能看一眼、补一句、也可以直接删掉。正文里只有「接手必须知道的」：
   * 在**目标工作树重算过的**分支 / HEAD / 变更数、源会话的文件引用对照、以及
   * 源会话**交接包里可迁移的知识**（没有就明说没有）。
   */
  rawHandle('yan:fork:context', async (_e, arg: unknown) => {
    const req = (arg ?? {}) as Parameters<typeof forkContext>[0]
    await handoffs.load()
    const packageOf = (sessionFile: string): HandoffPackage | null => {
      try {
        const key = normalizeSessionFileKey(sessionFile)
        return key ? handoffs.state(key).package : null
      } catch {
        return null
      }
    }
    return forkContext(req, packageOf)
  })

  rawHandle('yan:providerQuota', (_e, provider: unknown, budget: unknown) => providerQuota(String(provider ?? ''), Number(budget) || undefined))
}
