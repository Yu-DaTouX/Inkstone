# 测试指南（含「测试用哪个模型」）

> 本文是**测试约定**的单一真源。每次加/改测试场景前先读一读，
> 尤其是「测试模型」一节 —— 它决定真实调用会不会花钱。

## 三层测试

| 层 | 命令 | 特点 |
|---|---|---|
| 纯逻辑 | `npm run test:unit`（node） | 快、确定、能断言边界。不启动 Electron、不碰 pi、不花 token |
| UI + 接线 | `npm run test:live -- <场景>`（真实 Electron） | 完整主进程 / preload / IPC / pi 子进程。默认不调模型 |
| 真行为 | 带 `cost: 1` 的场景（见下） | 真模型、真工具、真图片 |

源码改动后先 `npm run build`，再跑 test:unit / test:live；live 不自动构建。运行 Electron 前，在 PowerShell 执行 `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`。

完整门槛为 `npm run check`，具体执行链以 [package.json](../../package.json) 为准；纯文档改动只核对内容、链接和命令，不必构建应用。
完整场景清单在 [`scripts/test-live.mjs`](../../scripts/test-live.mjs) 的 `CASES`。

## 测试模型（重要）

### 默认模型（以脚本配置为准）

所有**真实调用模型**的测试场景默认使用：

| 项 | 值 |
|---|---|
| 供应商 provider | `commandcode` |
| 模型 id | `inclusionai/ling-3.0-flash-sante:free` |
| 传给 pi 的 `--model` | `commandcode/inclusionai/ling-3.0-flash-sante:free` |
| 费用 | 脚本默认选择带 free 标识的模型；实际供应商计费与可用性需在调用前确认 |

默认配置用于避免跟随用户日常模型误耗额度；配置名不保证供应商长期免费或模型能力不变。

**免费模型有日配额**：Ling 是每天 100 次，跑多了 pi 会收到 429，而子代理/会话只会看到
“assistant 消息内容为空 + `stopReason=error`”——看上去像事件流掉了，其实是配额用尽。
确认方法：`YAN_DEBUG_SUBAGENT=1`（见 [MAINTENANCE](MAINTENANCE.md)）会把子代理事件落到临时文件，
里面能看到 `429 ... You've used all 100 free ... requests for today`。
备选免费模型：`commandcode/meituan/LongCat-2.0:free`、`commandcode/poolside/laguna-s-2.1-free`。

### 覆盖方式

```powershell
$env:YAN_TEST_MODEL = "provider/modelId"
npm run test:live -- e2e
Remove-Item Env:YAN_TEST_MODEL
```

- 变量：`YAN_TEST_MODEL`（默认见上）。
- 凭证与模型配置从真实目录只读复制到隔离 sandbox，测试仅修改副本；详见“隔离与安全”。
- 注入点：[`src/main/agent.ts`](../../src/main/agent.ts) 在启动 pi 时把 `YAN_TEST_MODEL`
  变成 `--model <值>`。正常运行时该变量为空，不影响用户。

### 例外：需要视觉的场景

Ling 3.0 Flash Sante 是**纯文本**模型（`input: ["text"]`），发图会失败。
需要视觉的场景在 `CASES` 里用 `model:` 单独覆盖，默认用：

| 项 | 值 |
|---|---|
| 场景 | `image`（把图片真的发给模型） |
| provider | `commandcode` |
| 模型 id | `deepseek/deepseek-v4.1-flash`（`input: ["text", "image"]`） |
| 覆盖变量 | `YAN_TEST_VISION_MODEL` |

**以后加需要视觉的新场景**：在 `CASES` 对应项里写 `model: TEST_VISION_MODEL`。

## 哪些场景会真的调模型（花钱/耗额度）

在 `CASES` 里标了 `cost: 1` 的场景：

| 场景 | 做什么 | 用哪个模型 |
|---|---|---|
| `tokens` | 用量 / 速度 | 默认（Ling） |
| `conn` | 连接状态竞态 | 默认（Ling） |
| `e2e` | 真发一条消息（流式 + 工具） | 默认（Ling） |
| `queue` | 排队 + Esc 回收 + **N09 边界**（四路并发入队 / 相同文本两条 / 对同文本撤回） | 默认（Ling） |
| `ask` | **问答功能**：模型主动提问 → 弹窗 → 回答 → 回填；含自主模式不弹窗 | 默认（Ling） |
| `image` | 图片真的发给模型 | **视觉模型** |
| `subagentpair` | **两个并发写入子代理**：worktree 隔离 / 合并 / 放弃 / 同一行冲突 / 只读封堵 / 退出归档 | `commandcode/deepseek/deepseek-v4.1-flash`（要求模型真的写文件） |
| `sessionab` | **A/B/C 三会话**：切走不停 / 切回不串 / 同 cwd 拒绝 / 单独停止 | `commandcode/deepseek/deepseek-v4.1-flash`（要求模型真的执行那个耗时工具） |
| `atrefsend` | **`@` 引用的真实发送**：补全选中 → 发送 → 退出后查会话 JSONL 确认引用到达（且模型能按路径读到文件） | `commandcode/meituan/LongCat-2.0:free` |

队列的**失败与并发边界**另有一个不花额度的场景 `queueretract`（**进 `npm run check`**）：
撤回一个 pi 里不存在的 id（= “刚被消费”走的是同一条分支）、连续撤回同一 id、两条并发撤回。
它只依赖「pi 在跑」——`Agent.removeQueued` 在找不到 id 时直接返回明确错误，不需要真实队列项。
⚠️ store 的 `removeQueued` 声明是 `Promise<void>`（不返回结果），断言要看通知与 `queueRestore`，
并且注意 `pushNotice` 对 8 秒内的同文案会去重（第二次不弹不一定代表什么也没发生）。

不标 `cost`（或 `cost: 0`）的场景按设计不主动调用模型；新增或改动探针时需核对实际调用链。
`subagent` 虽然标 `cost: 0`，但它真的起子代理并调一次模型（只是用免费模型）；配额耗尽时它会失败。

反过来，有两个 `cost: 0` 的场景会**真的起 pi**（但不发消息、不调模型），它们验的是真实状态而不是注入数据：

- `modelswitch`（N02）：真实模型列表上做切换、快速连切、无档位清空、图像输入与用量归属；已进 `npm run check`。
- `thinkinglevels` / `capabilityload`：真实档位与能力补拉（同上，只切换不发消息）。

## 隔离与安全

`test:live` 每个批次建一个临时 sandbox，把：

- `YAN_USER_DATA`（localStorage / cache）
- `YAN_SESSIONS_DIR`（会话文件）
- `YAN_DATA_DIR`（`desktop.json` 设置）
- `YAN_PI_DIR`（设置面板读写的凭证目录）

指到临时目录，**不碰真实数据**。

### pi 的凭证与模型目录（只读复制）

隔离让 pi 读不到 `~/.pi/agent`，直接后果是 **pi 起不来** —— 所有依赖「pi 就绪」的
场景（`runnerselect`、任何 `cost: 1`）都会失败或跳过。所以启动前会把这三个文件
**只读复制**进 sandbox：

| 文件 | 作用 | 少了会怎样 |
|---|---|---|
| `auth.json` | 凭证 | pi 只能起一个 `{id:'unknown'}` 空模型 |
| `models.json` | 自定义 provider 定义 | 本机的 `commandcode`（69 个模型）来自这里，**不在** pi 内置目录中；少了它 pi 解析 `--model commandcode/...` 会 `Model not found` **并直接退出**，表现为 conn 一直卡在 `starting` |
| `models-store.json` | 目录缓存 | 多一次网络拉取（不致命） |

安全边界（用户要求：测试可以用，**打包切勿放进去**）：

- 只**读**源文件；sandbox 在系统临时目录，跑完（含 Ctrl+C / SIGTERM）自动删除；
- `auth` 场景改写/删除的也只是副本；
- **不会进发布包**：`electron-builder.yml` 的 `files` / `extraResources` 只收
  `out/`、`build/icon.png`、`package.json` 和 `resources/pi-runtime`，临时目录不在其中；
- `.gitignore` 已忽略 `auth.json`。

不要关闭隔离来绕过测试失败；优先检查 sandbox 的配置、凭证副本与连接状态。

### 合成 fixture 项目（`fixture: true` 的场景）

文件树 / `@` 补全的边界需要一个**内容已知、可穷举**的项目：源码树里既造不出空目录，
也不能保证里面有哪些文件，断言只能写成“看起来像”。`test-live.mjs` 的
`buildFixtureProject()` 会在 sandbox 里造一棵固定的树，`CASES` 里标了
`fixture: true` 的场景把它当 `cwd`：

| 项 | 验什么 |
|---|---|
| `empty/` | 空目录（`status='empty'`，界面显示「（空目录）」） |
| `deep/a/b/c/d/e/f.txt` | 五级目录缩进与逐层展开 |
| `dup/one\|two/same.ts` | 同名文件按完整路径区分（加入上下文互不覆盖） |
| `big/`（60 项） | 文件树 50 一批分页 +「显示更多」；`@` 补全 30 条 + `truncated` |
| `uni/中文 目录/文件 名.ts` | 中文 + 空格路径（预览、补全、自动引用） |
| `notadir.txt` | 把文件当目录打开 → `missing`（不是空列表） |
| `junction-dir` / `junction-file` | 链接不进树/补全，但列在「已隐藏」名单里 |
| `noperm/` | 真实无权限目录（ACL 拒读）：`permission`，不是「空目录」 || `一个非常长的文件名…中文结尾.md` | 窄右栏（`PANEL_MIN=220`）下必须省略显示，但 `title` 能给全文 |

`noperm/` 用**真实 ACL** 造：`icacls <dir> /deny <当前用户>:(RD)` —— 只拒**读取/列举**，
不拒改 DACL，所以退出清理前能 `/remove:d` 复位（deny 全权限会让 `rmSync` 也 EPERM，
沙箱就删不掉了）。Windows 上 Node 的 `readdir` 在这里报 `EPERM`，主进程统一映射成
`permission`；非 NTFS 或改不了 DACL 的机器上造不出来，探针把对应断言降级为「跳过」
（既不假通过也不假失败）。清理钩子里会先复位 ACL 再删沙箱。

场景：`fsedge`、`atpathedge`（都进 `npm run check`）。树建在临时目录里，
批次结束随 sandbox 一起删除；**不要**往项目根塞测试数据。

### 直执行 shell 的变更归属（`workspacechanges`，进 check）

`workspacechanges` 是 L05 的真实窗口证据，而且**不花额度**：它走砚的
**直执行 shell 通道**（`window.yan.runBash` → pi 的 `bash` RPC），在隔离的
fixture 项目里真的建 / 改 / 删文件，然后断言工具行上的改动卡片。
八节分别盯一个新 / 改 / 无改 / 依赖目录 / 删 / 大文件（只能 `unknown`）/ UI 渲染 /
**同 cwd 第二个实例被拒**（L03 并发防线，见 `D20`）。

它必须用 `fixture: true`（会真改文件）；不需要真实模型 —— 这也是为什么不把它
归在 `cost: 1` 那批。另：fixture 的 `noperm/` 是不可读的，所以快照扫描器**不**因为
它把结果标成 `truncated`（见 `snapshots.ts` 里 `unreadableDirs` 的注释）。

fixture 里还有一个最小的 **Git 仓库** `repo/`（`git init` + 一次提交，README 里留了一行
`LINE-BASE:` 供“两个子代理改同一行”的冲突场景用）。写入型子代理要建 worktree，
所以 `subagentpair` 的 cwd 是 `fixtureSub: 'repo'`。

还有两个**已落盘**的合成会话（`writeProjectSwitchSessions`，`CASES` 里标
`projectSessions: true`）：cwd 分别是 fixture 项目根与它的 `other/`，标题为
`YAN-N05-A` / `YAN-N05-B`。“切回项目草稿还在”靠的就是它们 —— 草稿按 `sessionId`
存在运行时缓存里，换成新会话就回不来了，而刚 `new_session` 出来的会话还没有
消息、`listSessions` 解析不出 head，根本不在列表里。

`projectPeers: true` 时会**另外**在 `repo/` 里造 `YAN-N05-D` / `YAN-N05-E`：
`workspacechanges` 第 8 节要有**两条同 cwd 的会话**，才能验“同 cwd 已有实例在跑
时切换会被拒绝”。它们必须造在另一个子目录：摆在 A 旁边就会参与 N05 的
“该项目最近访问的会话”挑选（实测让 `projectswitch` 选到了新造的那条，
断言直接挂了）。同理，fixture 文件的 mtime 也按 `skew` 显式拨开 —— `listSessions`
的排序键是**文件 mtime**，而几个文件往往在同一毫秒内写出来。

### 退出之后才能看到的结论：`afterExit`

有些结论只在 **Electron 已经退出**之后才成立：退出归档（`review` 从 `pending` 变 `archived`）、
临时 worktree 有没有残留、主工作树的最终内容。这类场景在 `CASES` 里写
`afterExit: '检查名'`（注册在 `AFTER_EXIT`），探针跑完、进程退出后由 Node 侧直接查文件系统。

探针与 Node 侧靠**任务描述里的固定标记**对齐（如 `YAN-ALPHA`），不需要额外通道。
现有两个：`subagentArchive`（`subagentpair`）、`sessionabArchive`（`sessionab`）。

`subagentpair` 不进 `npm run check`：它要排队跑好几个真实的模型任务（实测约 1 分钟）、
消耗用户额度，按需手动跑。

### `delay` 与 `budget` 不是一回事（踩过）

- `delay`：窗口 `ready-to-show` 之后**等多久才执行探针**，用来给应用启动并连上 pi。
  普通场景 9～16 秒。不要为了“给长场景留时间”把它调大 —— 那只是让应用先白等。
- `budget`：**探针自己能跑多久**（kill 兜底 = `delay + budget`，默认 90 秒），
  探针跑完就退出，不用等满。
- 两者混在一起会让总时长虚高：`subagentpair` 曾经把 `delay` 设成 300 秒，
  于是总时长 275 秒里有 300 秒是白等；拆开后同一个场景 51 秒跑完。

## 问答功能怎么测

- **纯逻辑**（`npm run test:unit`）：`scripts/test-question.mjs` 直接 import
  内置扩展 `resources/pi-extensions/question.js`，喂假 `pi` API，断言
  系统提示随自主模式切换、自主模式不弹 UI、select/自定义/取消的回填。
- **端到端**（会调模型）：`npm run test:live -- ask`。流程：
  发一条要求提问的消息 → 等 UiBridge 弹窗 → 选答案 → 断言
  `question` 工具行完成、答案回填进模型回复；最后开自主模式，断言**不再弹窗**。

## 内置 pi 功能怎么核

- `npm run vendor:pi:check`：内置运行时能不能启动、RPC 握手是否正常。
- `npm run probe-pi`：单独验证「pi 能不能被找到并启动」。

## 视觉矩阵（截图证据）

不属于上面三层，但补的是同一类缺口（真实窗口证据）：

| 命令 | 作用 |
|---|---|
| `npm run visual:matrix` | 跑全部 8 组，每组一个 Electron 进程 |
| `npm run visual:matrix -- 0 2` | 只跑指定组（组号看 `GROUPS`；`onboarding` 是名字） |

覆盖：3 尺寸（1440x900 / 940x620 / 900x520）× 3 缩放（100/125/150%）× 深浅，状态包括主界面、模型菜单、推理块、设置面板、迷你项目栏、窄右栏文件树（`fsnarrow`：`PANEL_MIN=220` 下的超长名省略、缩进收敛、无权限目录提示）、shell 改动卡片（`wschanges` 正常归属 / `wsunknown` 同目录并发时的“无法归属”提示）与引导层。输出 26 张
`docs/design/preview/matrix-<state>-<尺寸>-<缩放>-<主题>-2026-09-16.png`（**新名，不覆盖任何已有预览图**）。

数据一律来自 `scripts/shot-fixture.js`（合成）：截图会进仓库，**绝不要**把真实会话截进去。

它不进 `npm run check`：依赖真实窗口与合成器，而且在部分环境上跑满会崩（见 [MAINTENANCE](MAINTENANCE.md)），属于人工/按需验收。

## 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/test-live.mjs` | live 场景注册表（`CASES`）+ 隔离 + 测试模型注入 |
| `scripts/test-unit.mjs` | 单元测试入口（纯逻辑） |
| `scripts/probe/*.js` | 各 live 场景的探针脚本（在真实渲染进程里执行）；`subagentpair.js` 是唯一带退出后检查的场景 |
| `scripts/visual-matrix.mjs` + `scripts/visual-matrix-run.mjs` | 视觉矩阵：真实窗口截图（分组跑批，每组一个进程） |
| `scripts/test-*.mjs` | 各模块的单测（在 `test-unit.mjs` 里用 esbuild 现场编译源码后跑） |
| `resources/pi-extensions/question.js` | 内置「提问」扩展（问答功能的模型侧） |
