# 证据 · 01-S4b `browser.js` 模型工具 → `yan browser …` CLI（2026-09-19）

> 本片按[并行代理编排](../../plan/active/编排-并行代理分工-2026-09-19.md) §2 任务卡 **A1** 执行，
> 是 [实施-01](../../plan/active/实施-01-默认pi架构迁移.md) **S4 的补片**：把 `resources/pi-extensions/browser.js`
> 里那批 `browser_*` 模型工具迁到随包 CLI，**解除 01-S5（移除默认扩展装载）的硬前置**。
>
> 为什么它排最前：S5 一旦移除默认扩展装载，模型原本靠扩展工具拿到的浏览器能力会
> **直接消失（不是降级，是丢失）**，而 `yan browser …` 当时**不在** `KNOWN_COMMANDS` 里。

## 1. 实现（改了什么）

| 文件 | 改动 |
|---|---|
| `src/main/capability-server.ts` | `KNOWN_COMMANDS` 登记 **19** 个 `browser.*` 命令（`browser.evaluate` **有意不登记**，见 §4 第 16 项） |
| `src/main/agent.ts` | 新增 `BrowserCommandHost` 接口（命令行面的显式清单）+ `browserHost` getter + `runBrowserCommand`（19 个动作）+ 参数窄化 + 错误分流；`runCapabilityCommand` 按 `browser.` 前缀分发 |
| `src/main/index.ts` | 注入 `browserHost: () => browser`（getter，agent 实例会随切会话重建） |
| `resources/yan-cli/yan.mjs` | 主用法加 `yan browser` 一行；新增 `GROUP_USAGE.browser`（`yan browser --help`）与 `GROUP_SPECS`（动作表 + 必填参数）；本地校验**前移到身份检查之前** |
| `resources/pi-extensions/browser.js` | **移除全部 `registerTool`（15 处代码点 / 16 个工具）与 `registerCommand('browser')`**；文件保留为说明性空占位（保留 `export default`，pi 加载扩展要求默认导出） |
| `src/main/browser.ts` | `click` / `type` / `press` / `scroll` / `requestUserControl` 由 `private` 改 `public`，新增 `public screenshot()`（只改**可见性**，权限 / 网络边界一行未动 —— 见 §5） |
| `scripts/probe/browser-cli.js`（新） | cost 0 场景：真进程外 CLI ↔ 宿主 ↔ 浏览器服务 |
| `scripts/probe/browser-cli-model.js`（新） | cost 1 场景：模型 → `yan browser navigate` → 读回执 → `yan browser observe` |
| `scripts/test-live.mjs` | `CASES` 表尾追加 `browsercli` / `browserclimodel` 两行（未动别人的行） |
| `scripts/test-unit.mjs` | 追加「01-S4b 浏览器 CLI」块（17 条断言） |

**调用通道的取舍**：宿主自己就在同一进程里，**直接调 `BrowserController` 的服务方法**，
不再经 loopback bridge。bridge（`YAN_BROWSER_BRIDGE_URL` + token）存在的唯一理由是
「扩展是进程外的、拿不到 Electron 对象」；宿主绕那一层只是把本地函数调用做成网络调用。
bridge 本身**没删**（`src/main/browser.ts` 不在本片文件域，且删它要动打包/启动参数），
遗留清理见 §6。

## 2. 16 个工具的逐个结论（出口 ①）

> 卡面写「17 个（编排卡写 18 个）」，**实际是 15 处 `pi.registerTool` 调用点 / 16 个工具**
> （其中 `browser_back` / `browser_reload` 由同一个循环注册两个）**+ 1 个 `pi.registerCommand('browser')`**。
> 逐个如下，无一项写成「已迁移」了事。

| # | 旧工具 | 新命令 | 判定 | 等价性 |
|---|---|---|---|---|
| 1 | `browser_open` | `yan browser open --url` | **已等价** | 同一 `navigate()`；`browsercli` 实测（经 `navigate` 别名） |
| 2 | `browser_navigate` | `yan browser navigate --url` | **已等价** | 同上；`browserclimodel` 由模型真实调用 |
| 3 | `browser_observe` | `yan browser observe` | **已等价** | 结构化观察同形；结果文件里 elements / text / generationId 齐全 |
| 4 | `browser_click` | `yan browser click --ref` | **已等价** | 同一 `click()`；一次性可见窗口验证：点下载链接**真的触发了下载**（§4-③） |
| 5 | `browser_type` | `yan browser type --ref --text` | **已等价** | 同一 `type()`；一次性验证：输入后提交，URL 带 `?q=yan-probe`（§4-③） |
| 6 | `browser_press` | `yan browser press --key` | **已等价** | 默认（不上屏）跑即有：回 ok + 带回新观察 |
| 7 | `browser_scroll` | `yan browser scroll --delta-y` | **已等价** | 上屏窗口实测 347ms 返回；坏参数回 `invalid_number`。⚠️ 隐藏窗口不返回，见 §6-② |
| 8 | `browser_back` | `yan browser back` | **已等价** | 同一 `back()`（历史 API 未动） |
| 9 | `browser_reload` | `yan browser reload` | **已等价** | 同一 `reload()`（顺带清 registry，与旧路径一致） |
| 10 | `browser_new_tab` | `yan browser new-tab` | **已等价** | `browsercli` 实测：标签 1→2、新标签为活动 |
| 11 | `browser_switch_tab` | `yan browser switch-tab --id` | **已等价** | `browsercli` 实测：活动标签切回目标 id |
| 12 | `browser_screenshot` | `yan browser screenshot` | **已等价（形态不同）** | PNG **落盘**，摘要给路径与字节数；上屏实测 1564 字节、魔数 `89504e47`。旧工具把 base64 塞进消息体 —— 现在模型用原生 `read` 看图（见 §6-① 的限制） |
| 13 | `browser_download` | `yan browser download` | **已等价** | 数据同源（`state.lastDownload`）；无下载时回 `has:false` 而不是空话 |
| 14 | `browser_request_user_control` | `yan browser request-user-control [--reason]` | **已等价** | 同一 `requestUserControl()`；`browsercli` 实测接管后 `press` 被拒（`USER_CONTROL_ACTIVE`）。`--reason` 只进摘要 —— 旧路径也从未把它落盘或展示，不为它新增用户可见功能 |
| 15 | `browser_connect_local_chrome` | `yan browser connect-chrome [--url]` | **已等价** | 同一 `openExternalChrome()`；真实接入链路由 `externalchrome` / `browserboundary`（cost 0，需本机 Chrome）覆盖 —— 那是同一对服务方法的另一条调用方 |
| 16 | `browser_disconnect_local_chrome` | `yan browser disconnect-chrome` | **已等价** | 同一 `closeExternalChrome()`；同上 |
| — | `/browser`（pi 斜杠命令） | 不变 | **不做（有意）** | `registerCommand('browser')` 与 Yan 自己的 `/browser`（`src/main/command-registry.ts`，走 `window.yan.browser.open`）**重名**。删掉 pi 那条后，`slashcmd` 场景仍验「`/browser about:blank` 真的开了原生视图」且**没有** `source=extension` 的重复项 |
| 附 | （无对应工具）`browser.state` / `browser.forward` | 新增命令 | **补登记，非新能力** | bridge 早有 `/state` 与 `/forward` 端点；`state` 还是 `switch-tab` 所需标签 id 的**唯一来源**（旧工具链根本没给模型这个来源） |
| 附 | （无对应工具）`/evaluate` | **不做（有意）** | 不登记 | bridge 的 `/evaluate` 一直返 403（不提供任意页面 JavaScript）；单测断言 `browser.evaluate` 仍是 `unknown_command` |

## 3. 自动检查（出口 ② 的一半）

```
npm run typecheck   → exit 0（tsc node + web + CSS 约定 + CSS layer 自检）
npm run build       → exit 0
npm run test:unit   → 2684/2684 通过（含新增「01-S4b 浏览器 CLI」块 17 条）
```

新单测块断言（`scripts/test-unit.mjs`）：
`browser.js` 调 `default(pi)` 时**零注册**（工具 / 命令 / 钩子）且保留默认导出；
`browser.navigate` 真落到 handler；`browser.evaluate` 仍是 `unknown_command`；
`yan browser --help` 退出码 0 且列出动作；主用法含 `browser` 一行；
未知子命令 / 漏参数走退出码 2 且**不抛堆栈**；无宿主环境走退出码 3（与业务失败 1 分开）；
`GROUP_SPECS` 的每个动作都在 `GROUP_USAGE` 里有文案。

`yan browser --help` 真跑（人工命令，输出见下）：

```
$ node resources/yan-cli/yan.mjs browser --help
yan browser <动作> [选项]
动作（结果都落成 JSON 文件；stdout 只回一段摘要）：
  navigate --url <地址>          打开 http(s) 页面（about:blank 也可以）
  open     --url <地址>          navigate 的别名
  state / observe / click / type / press / scroll / back / forward / reload
  new-tab / switch-tab / close-tab / screenshot / download
  request-user-control / connect-chrome / disconnect-chrome
```

## 4. 真实运行（出口 ② ③ ④ ⑤）

### ① `npm run test:live -- browsercli`（cost 0，默认**不上屏**）

场景前提：真实 Electron + 真实 pi 子进程 + 合成 fixture 项目；`about:blank`，**不依赖外网**。
CLI 调用走 `window.yan.runBash`（直执行 shell，**不经模型**），它继承 pi 子进程环境
（PATH 前置 `yan` 启动器 + `YAN_CLI_*` 身份）—— 所以验的是**真进程外 CLI**。

```
✓ browsercli 通过（0 条 ✗）
  0. 扩展面：commands 里 name=browser 的 source = ["yan"]（没有 extension 那条）
  1. yan browser --help：退出码 0、列出 navigate/observe/screenshot、无堆栈
  2. 未知子命令：退出码 2、{"error":"未知的 browser 子命令：frobnicate"}、无堆栈
  3. 缺参数：CLI 侧退出码 2 指出 --url；宿主侧（--request-file {"ref":"   "}）
     回 code=missing_ref（CapabilityCommandError 业务错误，不是端点错误）
  4. 浏览器未打开：code=browser_not_open、无堆栈、不落空结果文件
  5. navigate：ok=true + operationId + resultFile；stdout 无 "permissions"
     （大结果只在文件里）；渲染端 browserState.open=true / url=about:blank
  6. observe：generationId + elements 数在摘要里；elements 数组只在结果文件里
  7. state/new-tab/switch-tab/close-tab：标签 1→2→切回→关到 1
  8. press：ok=true 且带回新观察
  9. scroll：坏参数回 invalid_number（不把 NaN 传给 CDP）
 10. screenshot：跳过（隐藏窗口，见 §6-②）
 11. download：ok=true + has=false
 12. request-user-control：userControl=true；随后 press 被拒（USER_CONTROL_ACTIVE）
 13. click/type：跳过（需要带元素的页面，见 §6-③）
```

### ② 同上，`YAN_SHOW_WINDOW=1`（上屏，补齐鼠标 / 截图两节）

```
✓ scroll 回 ok=true（上屏窗口）  347ms     ✓ scroll 带回新观察
✓ 浏览器面板已按 UI 路径打开（视图有真实 bounds）
✓ 截图回 ok=true   ✓ mimeType=image/png   ✓ 摘要里给了 .png 路径
  文件字节=1564  头 4 字节=89504e47        ✓ PNG 魔数正确
✓ browsercli 通过（0 条 ✗）
```

### ③ 一次性可见窗口验证：`click` / `type`（真元素页面）

`about:blank` 上没有可交互元素，而「任意页面 JavaScript」是被有意关掉的，所以借了 L04 那个
`127.0.0.1:39873` 本地 fixture 页面（仍不出本机），并在其根页面**临时**加了一个表单：

```
  元素：["4:e1:link:download","4:e2:textbox:textbox","4:e3:button:go"]
  ✓ click 下载链接 ok=true
  download={"has":true,"filename":"yan-probe-download.txt","path":"…\\downloads\\yan-probe-download.txt"}
  ✓ click 真触发了下载
  ✓ type ok=true
  提交按钮回执={"ok":true,…,"url":"http://127.0.0.1:39873/whoami?q=yan-probe",…}
  ✓ click 提交按钮 ok=true
  提交后 url=http://127.0.0.1:39873/whoami?q=yan-probe
  ✓ typed 文本真的进了输入框（URL 带 q=yan-probe）
```

**临时改动已全部还原**（fixture 页面、临时 CASES 行、临时探针都删了；`git status` 里只剩本片文件）。
同时这份一次性验证暴露了两条**既有**语义，不是回归：
re-observe 后 ref 换代（`STALE_ELEMENT` 属正常，模型按回执重新 observe 即可）；
`click` 触发下载时下载记录的落地比点击回执晚一点（`has` 偶见 false，故未写成永久断言）。

### ④ 模型端到端：`npm run test:live -- browserclimodel`（cost 1）

**提示里故意不给命令名**（只给目标：「找到砚的能力入口，打开 about:blank，告诉我 URL 与可交互元素数」）——
因为本片真正要回答的是「16 个工具删掉后，模型还能不能**自己**找到 `yan browser`」，
直接告诉它敲什么就只验了执行链。两次独立运行都通过，其中一次的完整轨迹：

```
yan 命令序列：[ "yan --help 2>&1 | head -60",
                "yan capabilities --help 2>&1 | head -40",
                "yan browser --help 2>&1 | head -60",
                "yan browser navigate --url about:blank 2>&1",
                "yan browser state 2>&1",
                "yan browser observe 2>&1" ]
  bash 工具调用 7 次；其中 yan 6 次  宿主浏览器状态：open=true url=about:blank
  ✓ 模型真的用了 bash（不是自己编输出）
  ✓ 模型**自己找到了** `yan` 能力入口（提示里没给命令名）
  ✓ 模型敲了 `yan browser navigate/open` 并拿到 ok 回执
  ✓ 模型**基于回执继续**敲了 `yan browser observe/state`
  ✓ 宿主真的打开了 about:blank（CLI → 宿主链路生效）
  ✓ 模型答出了当前页面 URL
  ✓ 没有「找不到 yan 命令」/「宿主不可用」/unknown_command
```

模型最终回答（摘要）：“找到了 `yan browser` 组，看它的动作列表……
`yan browser navigate --url about:blank` → `open: true`、`mode: embedded`、`tabs: 1`；
活动标签 `tab-5f57c990e1`；`observe` → 无障碍节点 3，可见文本 0 字符。”
—— 这些数字都是**真回执里的值**（宿主确认真开了页面），不是编的。

> ⚠️ 默认免费模型 `commandcode/longcat-2.0:free` 在 2026-09-19 实测对这条多步提示
> 连续返回「模型返回错误」（模型侧错误，非本片代码），所以 CASES 里给这条**固定**了
> `model: deepseek/deepseek-v4.1-flash`（同一免费档，两次实测都稳定跑完）。

### ⑤ 既有场景回归（确认「删工具」没有连带破坏）

```
npm run test:live -- browser browserboundary slashcmd   → 全部通过（3 个场景）
  browser          ✓（内置浏览器面板 / CDP 观察 / 标签页，走 IPC 那条链）
  browserboundary  ✓ 全部通过（L04：逐站权限、下载来源、Cookie 转移、DNS 重绑定、file:// 拒绝）
  slashcmd         ✓ 全部通过（含 `/browser about:blank` 真的开原生视图、没被当消息发出）
```

`browserboundary` 全绿是本片「**没有放宽权限 / 网络边界**」的直接证据。

## 5. 大结果落文件 / 摘要（出口 ⑤）

每个动作走 capability-server 既有契约：`data` → `resultFile`；`summary` → stdout。
`browsercli` 逐条断言了它：`navigate` 的 stdout 里**没有** `permissions`（完整状态在文件里）、
`observe` 的 stdout 里**没有** elements 数组（全文在文件里）、业务错误不带数据时**不落空文件**。
截图更进一步：PNG 单独落盘（几 MB 的 base64 不进 JSON 结果文件），摘要只给路径 + 字节数。

## 6. 剩余限制（不静默降级）

1. **截图形态变了**：旧 `browser_screenshot` 把图片数据直接放进工具结果（模型那轮就看得到图）；
   现在是「PNG 落盘 + 路径」，模型要用原生 `read` 去读。**功能等价、少一次往返才看到图**。
   端到端「模型看图」这条链本片没验（要视觉模型 + 真图），留给 09 的验收尾巴。
2. **隐藏测试窗口下鼠标 / 截屏类 CDP 调用不返回**（**迁移前就存在，非本片引入**）：
   `Input.dispatchMouseEvent(mouseWheel)` 与 `Page.captureScreenshot(fromSurface)` 在
   `YAN_PROBE_HIDDEN=1` 时 20s 超时不回；同一台机器 `YAN_SHOW_WINDOW=1` 时分别 347ms / 227ms。
   本套测试默认不上屏（用户要求），所以这两节在默认跑里**显式跳过并打印原因**，
   证据取自上屏那一轮（§4-②）。能不能在隐藏窗口里也能用，需要单独一片处理（属浏览器服务，不在本片文件域）。
3. **`click` / `type` 没有常驻自动断言**：它们需要「带元素的本地页面」，而唯一现成的 fixture
   属于 L04（与一批 Cookie 转移断言绑定，`usesBoundaryServer` 一开就必须满足它们）。
   本片用一次性可见窗口验证拿了真实证据（§4-③），**没有留下永久回归保护** ——
   要做的话应先给浏览器场景一个自己的本地页面 fixture。这一条要人拍板。
4. **UI 里的旧工具名**：`src/main/browser/ElementRegistry.ts:18` 与 `src/main/browser.ts:1279`
   的 STALE_ELEMENT 文案仍写着 `browser_observe`。两者**不在本片文件域**，所以改为在
   `agent.ts` 把回给模型的文案重写成 `yan browser observe`（`cliHint()`，已验证生效：
   回执变成「请重新调用 yan browser observe。」）。源码里的字面文案建议由编排者顺手改掉
   （各一行，纯文案）。
5. **`resources/pi-extensions/browser.js` 现在是空占位文件**（零注册，保留 `export default`）。
   保留而不是删除的理由：薄层清单 / 来源诊断（`yanThinExtensionPaths`）与插件页「内置能力」
   按**实际加载的扩展文件名**派生，删文件会让清单少一项，而 `visual-matrix` 的截图桩
   （`scripts/visual-matrix.mjs`，别片文件域）仍写 6 项 —— 会造出「截图与事实不一致」。
   **对 01-S5 的影响：零**。S5 移除默认扩展装载时它随之不再加载，因为已经不注册任何东西，
   移除它**不会造成任何能力变化**（浏览器能力在 `yan browser` 里）。S5 顺手删掉它即可。
6. **loopback bridge 成为死代码**（`BrowserController.startBridge()` / `bridgeEnv()` /
   `YAN_BROWSER_BRIDGE_*`）。本片**没删**：它属 `src/main/browser.ts`（不在文件域），
   删除还会牵动 `agent.ts` 的 `browserEnv` 与启动参数。仍只监听回环 + 一次性 token，
   **没有放宽任何边界**；建议在 01-S5 一并清理。
7. **`browsercli` 还没进 `npm run check` 的场景清单**：那一行在 `package.json`，不在本片文件域。
   编排者把它加进 `check` 的 `test:live -- …` 列表即可（cost 0，纯 `about:blank`，几十秒）。

## 7. 需要人拍板 / 待编排者登记

| # | 事项 | 建议 |
|---|---|---|
| 1 | `browsercli` 进 `npm run check` 清单（`package.json`） | 加，cost 0 |
| 2 | `click` / `type` 的永久回归保护（要不要给浏览器场景一个自己的本地 fixture） | 拍板；不做就保留 §6-③ 的限制 |
| 3 | `ElementRegistry.ts` / `browser.ts` 里旧工具名的字面文案（各一行） | 顺手改 |
| 4 | 隐藏窗口下鼠标 / 截屏 CDP 不返回（**既有问题**，现在成了模型唯一路径） | 单独开一片；本片只记录复现 |
| 5 | 01-S5 时删除空占位的 `browser.js` + 死掉的 loopback bridge | 归 S5 |
| 6 | HANDOFF / README 的状态列 | 由编排者统一登记（本片不改这两个文件） |
