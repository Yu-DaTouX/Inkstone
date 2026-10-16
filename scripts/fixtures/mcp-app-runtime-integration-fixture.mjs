/**
 * `test-mcp-app-runtime-integration.mjs` 的合成夹具。
 *
 * 1. `electron` 桩：`src/main/agent.ts` 的依赖链里只有 `search/hidden-page.ts`
 *    导入 `BrowserWindow` / `session`（读网页正文用）。集成脚本要在纯 Node 里
 *    构造**真实 AgentController**，但不会调用浏览器路径，所以用 esbuild `alias`
 *    把 `electron` 指到这里；模块顶层只解构两个占位导出，不触网、不建窗口。
 * 2. 可控配置读取器：给启动见证的采集 / 复核注入延迟，用来制造
 *    「stop 发生在 capture / verify 期间」的真实竞态。
 */
export const BrowserWindow = class {}
export const session = { fromPartition: () => ({}) }

/**
 * 包裹真实 fs 读取器，按第 N 次调用延迟。
 * `delays` 形如 `{ 1: 300, 3: 400 }`；`started` 记录已经开始延迟的调用序号。
 */
export function delayingNativeConfigReader(readReal, delays = {}) {
  let index = 0
  const started = new Set()
  return {
    started,
    get index() {
      return index
    },
    reader: async (path) => {
      index += 1
      const current = index
      const delay = delays[current]
      if (delay) {
        started.add(current)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      return readReal(path)
    }
  }
}
