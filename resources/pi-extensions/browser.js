/*
 * Yan built-in browser extension — **已停用（2026-09-19 · 01-S4b）**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件现在什么都不注册
 * ══════════════════════════════════════════════════════════════════
 * 它以前注册 16 个 `browser_*` 模型工具 + 一个 `browser` 斜杠命令，通过
 * loopback bridge（`YAN_BROWSER_BRIDGE_URL` + token）驱动内置浏览器。
 *
 * 架构修订（docs/archive/2026-09-18-架构修订-默认pi与砚原生能力层.md）要求
 * 砚自有薄层**不注册模型工具、不注册 pi 命令**，所以那些注册全部移除。
 * 等价能力改走随包 CLI：`yan browser <动作>` ——
 *   · 登记：src/main/capability-server.ts 的 KNOWN_COMMANDS
 *   · 实现：src/main/agent.ts 的 runBrowserCommand（**直接调宿主服务方法**，
 *     不再绕 HTTP bridge）
 *   · 用法：resources/yan-cli/yan.mjs 的 GROUP_USAGE.browser
 *
 * ── 为什么保留空文件，而不是删掉 ──
 *   · 插件页的「内置能力」列表与来源诊断按**实际加载的扩展文件名**派生
 *     （src/main/extensions-inventory.ts），删文件会让那两处与
 *     scripts/visual-matrix.mjs 的截图桩（别片文件域）对不上；
 *   · `pkg.builtin.browserDesc`（「给模型一个能看网页、能截图的原生视图」）
 *     描述的是**能力**而不是载体 —— 迁移后仍然成立；
 *   · 01-S5 移除默认扩展装载时它会随之不再加载，而因为它**已经不注册任何东西**，
 *     移除不会造成任何能力变化（浏览器能力在 `yan browser` 里）。
 *
 * 保留 `export default`：pi 加载扩展时要求默认导出，纯注释文件会让它报错。
 */
export default function browserExtension() {
  /* 不注册工具、不注册命令、不挂任何钩子 —— 理由见文件头。 */
}
