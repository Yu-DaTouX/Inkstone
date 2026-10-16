import { isAbsolute } from 'node:path'
import type { PiProbe } from '../shared/ipc'

export type PiRpcRuntime =
  | { kind: 'node'; executable: string; cli: string }
  | { kind: 'electron'; executable: string; cli: string }
  | { kind: 'native-exe'; executable: string }

export function runtimeProbe(runtime: PiRpcRuntime): PiProbe {
  if (runtime.kind === 'native-exe') {
    if (!isAbsolute(runtime.executable)) {
      throw new Error(`native-exe 运行时需要绝对路径：${runtime.executable}`)
    }
    return {
      ok: true,
      source: 'override',
      cmd: runtime.executable,
      args: [],
      tried: ['explicit native-exe runtime']
    }
  }
  return {
    ok: true,
    source: 'override',
    cmd: runtime.executable,
    args: [runtime.cli],
    tried: ['explicit host runtime']
  }
}

export function ignoresElectronRunAsNode(runtime: PiRpcRuntime | undefined): boolean {
  return runtime?.kind === 'node' || runtime?.kind === 'native-exe'
}
