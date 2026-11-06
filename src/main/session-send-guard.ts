import { pick } from '../shared/ui-lang'
export type BusyCwdLookup = (cwd: string, exceptRunId?: string) => boolean

export interface ExecuteGuardInput {
  runnerId: string
  cwd: string
  selfBusy: boolean
}

export type ExecuteGuardResult = { ok: true } | { ok: false; error: string }

export interface ExecuteAdmissionClaim {
  token: number
  runId: string
  generation: number
  cwd: string
}

export interface ExecuteAdmissionPort {
  claim(): { ok: true; token: number } | { ok: false; error: string }
  confirm(token: number): boolean
  release(token: number): void
}

export const SAME_CWD_ADMISSION_ERROR =
  '同一工作目录已有会话正在开始执行，本次不会同时放行。请等它跑完或停止它。'

export const sameCwdAdmissionError = (): string =>
  pick(SAME_CWD_ADMISSION_ERROR, 'Another session in this working folder is starting. Wait for it to finish or stop it.')

export function admissionClaimedBy(
  claim: ExecuteAdmissionClaim | null | undefined,
  id: string,
  generation: number | undefined
): boolean {
  return !!claim && claim.runId === id && claim.generation === generation
}

export const SAME_CWD_BUSY_ERROR =
  '同一工作目录还有另一个会话正在运行，这次不会开始执行：两个同时写文件的回合会互相覆盖。请等它跑完或停止它。'

export const sameCwdBusyError = (): string =>
  pick(SAME_CWD_BUSY_ERROR, 'Another session is running in this working folder, so this one will not start: concurrent turns writing files would overwrite each other. Wait for it to finish or stop it.')

export function guardSameCwdExecute(
  input: ExecuteGuardInput | null,
  hasBusyCwd: BusyCwdLookup
): ExecuteGuardResult {
  if (!input?.runnerId || !input.cwd) return { ok: true }
  if (input.selfBusy) return { ok: true }
  return hasBusyCwd(input.cwd, input.runnerId) ? { ok: false, error: sameCwdBusyError() } : { ok: true }
}
