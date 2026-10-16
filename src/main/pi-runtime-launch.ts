/**
 * 显式宿主运行时的启动描述（PB2 `native-exe` 候选）。
 *
 * 只在调用方明确给出 `PiRpcOptions.runtime` 时使用：默认定位（`resolvePi`、
 * 随包 / 全局 / PATH 发现）的语义完全不变。
 *
 * `native-exe` 与 `node` / `electron` 的差别只在“怎么起”：
 *   · `node` / `electron`：`<executable> <cli.js> --mode rpc ...`，Electron 还要
 *     `ELECTRON_RUN_AS_NODE=1` 才当纯 Node 跑；
 *   · `native-exe`：绝对路径 exe 直接 `--mode rpc`，没有 JS CLI 前缀，也不能
 *     继承 `ELECTRON_RUN_AS_NODE`（原生 exe 不是 Node）。
 *
 * 这里只做纯字符串/路径判定，不 spawn、不做自动发现，也不回退到全局 pi。
 */
import { isAbsolute } from 'node:path'
import type { PiProbe } from '../shared/ipc'

export type PiRpcRuntime =
  | { kind: 'node'; executable: string; cli: string }
  | { kind: 'electron'; executable: string; cli: string }
  | { kind: 'native-exe'; executable: string }

/**
 * 组装显式运行时对应的探测结果，不做桌面 / 全局发现。
 *
 * `native-exe` 必须是绝对路径：拼出来的命令会直接 spawn，不接受相对路径带来的
 * “按 cwd / PATH 解析到别的程序”的可能。路径不存在留给 spawn 的 `error` 事件
 * 如实上报，不在这里静默改跑别的运行时。
 */
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

/**
 * 子进程是否必须清掉 `ELECTRON_RUN_AS_NODE`。
 *
 * `node` / `native-exe` 都清（都不是 Electron 壳）；`electron` 与默认定位
 * （随包 `cli.js`）仍按原样注入 `'1'`，不改变既有语义。
 */
export function ignoresElectronRunAsNode(runtime: PiRpcRuntime | undefined): boolean {
  return runtime?.kind === 'node' || runtime?.kind === 'native-exe'
}
