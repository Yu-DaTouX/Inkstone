import {
  findSessionBaseline,
  readCheckpointFileDiff,
  readCheckpointTreeDiff,
  type CheckpointBaseline,
  type CheckpointFileDiff,
  type CheckpointTreeDiff
} from '../checkpoints'

export interface SessionSourceDeps {
  findBaseline?: (cwd: string, sessionKey: string) => Promise<CheckpointBaseline | null>
  readTree?: (cwd: string, sha: string, opts?: { maxBytes?: number; timeoutMs?: number }) => Promise<CheckpointTreeDiff>
  readFile?: (cwd: string, sha: string, relPath: string, opts?: { maxBytes?: number; timeoutMs?: number }) => Promise<CheckpointFileDiff>
}

export interface SessionTreeRead {
  ok: boolean
  unavailable?: 'session-baseline-missing'
  error?: string
  baseline: CheckpointBaseline | null
  nameStatus: string
  numstat: string
  patch: string
  patchTruncated: boolean
}

const EMPTY_TREE = { nameStatus: '', numstat: '', patch: '', patchTruncated: false } as const

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
