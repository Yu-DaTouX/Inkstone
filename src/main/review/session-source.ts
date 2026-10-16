/**
 * 评审「本会话改动」来源的会话基线读取（§10.2 / WP-50）。
 *
 * ── 为什么单独一份 ──
 * `changes.ts` 负责把四类来源统一成 `ReviewChangeSet`，但「本会话改动」不是
 * 主仓 HEAD，而是**该会话最早的 turn 检查点**与当前工作树之间的差异。这里
 * 只做这一段的读取编排：
 *   · 基线来自 `checkpoints.findSessionBaseline`（同 cwd + 已验证 sessionKey）；
 *   · 文件清单与补丁来自 `readCheckpointTreeDiff` 的**同一份影子 index 快照**；
 *   · 单文件正文来自 `readCheckpointFileDiff`，与清单同源同版本。
 *
 * ── 硬边界 ──
 *   · 纯读：不 restore、不 commit、不写 `index.json`、不新建检查点记录；只
 *     反射影子仓库自己的 index（不碰项目 `.git/index` 与工作树）；
 *   · 无基线或基线不可读时返回明确 `unavailable`，**不**回退到未提交改动或
 *     主仓 HEAD 冒充会话开始；
 *   · 依赖以窄接口注入，provenance 单测用假基线 / 假补丁即可覆盖，不碰真实仓库。
 */
import {
  findSessionBaseline,
  readCheckpointFileDiff,
  readCheckpointTreeDiff,
  type CheckpointBaseline,
  type CheckpointFileDiff,
  type CheckpointTreeDiff
} from '../checkpoints'

/** 会话来源的读取依赖；缺省都走影子仓库的只读实现。 */
export interface SessionSourceDeps {
  findBaseline?: (cwd: string, sessionKey: string) => Promise<CheckpointBaseline | null>
  readTree?: (cwd: string, sha: string, opts?: { maxBytes?: number; timeoutMs?: number }) => Promise<CheckpointTreeDiff>
  readFile?: (cwd: string, sha: string, relPath: string, opts?: { maxBytes?: number; timeoutMs?: number }) => Promise<CheckpointFileDiff>
}

/** 会话基线变更集的原始读取结果（文件清单 / 补丁由 `changes.ts` 解析）。 */
export interface SessionTreeRead {
  ok: boolean
  /** 只有「没有可用基线」这一类不可用；其他错误也归到这里并带 error */
  unavailable?: 'session-baseline-missing'
  error?: string
  baseline: CheckpointBaseline | null
  nameStatus: string
  numstat: string
  patch: string
  patchTruncated: boolean
}

const EMPTY_TREE = { nameStatus: '', numstat: '', patch: '', patchTruncated: false } as const

/** 读某会话的基线差异（清单 + 完整补丁）。 */
export async function readSessionTree(
  cwd: string,
  sessionKey: string,
  deps: SessionSourceDeps = {}
): Promise<SessionTreeRead> {
  const findBaseline = deps.findBaseline ?? findSessionBaseline
  const readTree = deps.readTree ?? readCheckpointTreeDiff
  const baseline = await findBaseline(cwd, sessionKey)
  if (!baseline) {
    return {
      ok: false,
      unavailable: 'session-baseline-missing',
      error: '这个会话还没有可用的起始快照，无法确定「本会话改动」',
      baseline: null,
      ...EMPTY_TREE
    }
  }
  const tree = await readTree(cwd, baseline.sha)
  if (!tree.ok) {
    return {
      ok: false,
      unavailable: 'session-baseline-missing',
      error: tree.error ?? '会话基线快照不可读',
      baseline,
      ...EMPTY_TREE
    }
  }
  return {
    ok: true,
    baseline,
    nameStatus: tree.nameStatus,
    numstat: tree.numstat,
    patch: tree.patch,
    patchTruncated: tree.patchTruncated
  }
}

/** 读单个文件相对会话基线的补丁；无基线时明确不可用。 */
export async function readSessionPatch(
  cwd: string,
  sessionKey: string,
  relPath: string,
  deps: SessionSourceDeps = {}
): Promise<CheckpointFileDiff> {
  const findBaseline = deps.findBaseline ?? findSessionBaseline
  const readFile = deps.readFile ?? readCheckpointFileDiff
  const baseline = await findBaseline(cwd, sessionKey)
  if (!baseline) {
    return {
      ok: false,
      error: '这个会话还没有可用的起始快照，无法读取该文件的会话差异',
      path: String(relPath ?? ''),
      patch: '',
      truncated: false,
      binary: false,
      bytes: 0
    }
  }
  return readFile(cwd, baseline.sha, relPath)
}
