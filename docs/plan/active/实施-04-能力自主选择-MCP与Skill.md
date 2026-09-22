# 实施-04 · 模型自主搜索、接入与使用能力（Skill / MCP / CLI）

> 面向实施 agent；2026-09-18 建立（合并 [实施方案-C-MCP与Skill自主选择](../../archive/2026-09-18-实施方案-C-MCP与Skill自主选择.md)，
> 并按 [实施-01](实施-01-默认pi架构迁移.md) 把 `capability_*` / `mcp_*` 从「拟注册的模型工具」改为 **`yan` CLI 子命令**；原件已归档）。
> 本文是该主题的**唯一真源**。本轮只整理方案，**不连接外部账号、不安装 MCP/Skill、不修改用户配置**。

## 0. 一句话结论

用户只给目标；模型**先选择现有能力**，不足时**自行联网搜索 Skill / MCP、评估候选、按策略安装或连接、验证可用，然后继续原任务**，
并能说明所用能力、失败原因与结果证据。
**联网发现与自动接入是必做范围**，不能只交付本地目录查询。

**能力使用优先顺序**：已有本地工具 / 脚本 → 合适的 Skill 流程 → 发布方 CLI / API → 确实需要的 MCP。
用户明确指定 MCP 或某能力时优先满足，**不以此排序否定要求**。

> ⚠️ **禁止的旧路径**：预装 `pi-mcp-adapter` / `pi-web-access`，或新建 `resources/pi-extensions/capabilities.js`，
> 或把 adapter 改名藏进 pi 启动链。pi 包目录（pi.dev/packages）只作**能力线索与设计参考**，不是预装清单。

## 1. 已核实的现状基础（2026-09-18）

| 能力 | 核查结论 | 砚应如何处理 |
|---|---|---|
| 发现已配置路径 / 包中的 Skill，按任务读取正文 | pi 原生支持；先名称说明，再按需加载 | **复用**，不重写 Skill 标准 |
| 安装已知 npm / git / 本地来源的 pi 包 | pi 原生有 install / list / remove | 复用版本相容的包管理；**不等于**模型已会联网找未知包 |
| 项目配置已声明的缺失包自动安装 | 官方包文档有此行为 | 属于「恢复已声明依赖」，不是按目标搜索新能力 |
| MCP 客户端 / 工具接入 | 本机 README 与官网均明确**核心不内置 MCP** | 由**砚**管理宿主连接；第三方 MCP 扩展不等于 pi 原生 |
| 按目标联网检索未知 Skill / MCP 并自动接入、验证、续行 | 未发现 pi 原生完整工作流 | **本方案补齐完整工作流** |

现状核查点：

- `resources/pi-runtime/package.json` 与本机全局包版本一致（`0.85.1`），但**包文件版本不是运行实例证据**；
  用户覆盖 `piBin` 时，实施 agent 必须再通过 [protocol.ts](../../../src/main/protocol.ts) 的 `resolvePi` 核实。
- pi 启动有内置扩展入口；普通会话未传 `no-skills`；砚识别 skill 命令来源。
- [packages.ts](../../../src/main/packages.ts) 通过 pi CLI 管理包；**运行时装卸被拒**，且这不意味着 MCP 服务已连通。
- 本次 `src` / `resources` 静态范围**未找到**完整 MCP 连接管理、工具发现与调用服务；
  实施前复核实际配置与依赖，**不能**据此断言用户所有第三方包都不具备 MCP。
- 模型借 `bash` 临时拼下载 / 安装命令可能做到某一步，**不等于**宿主已有可观察、可恢复的产品能力；不作为验收。

依据：[pi Skill 机制](https://pi.dev/docs/latest/skills)、[pi 包管理](https://pi.dev/docs/latest/packages)、
[MCP 工具协议](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、
[MCP 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、
[MCP Registry](https://modelcontextprotocol.io/registry/about)。

## 2. 命令面（拟建，不是当前命令）

```text
yan capabilities search   --query-file query.json --scope available
yan capabilities discover --query-file query.json
yan capabilities prepare  --candidate ID
yan capabilities acquire  --plan ID
yan operations status     --id ID
yan skill read            --id ID
yan mcp describe          --server ID --tool NAME
yan mcp call              --request-file request.json --output result.json
```

设计约束：

- 首版是**固定数量的 CLI 子命令 + 按需返回 schema**，**不以「运行中动态注册任意工具」为前提**。
- 若当前 pi 已完整提供 Skill 按需读取，**复用其目录与 `read` 流程**；
  `yan skill read` 只在「目录规模大、来源追踪 / 禁用约束需要」时使用，**不并行维护两份发现规则**。
- 后续可增加原生动态工具暴露，但**不能双注册**同一能力。

## 3. 宿主结构

**拟新增**

| 路径 | 职责 |
|---|---|
| `src/main/capabilities/catalog.ts` | 登记与过滤，**不执行业务** |
| `src/main/capabilities/skill-service.ts` | 读取 pi 实际资源发现结果、校验路径与前置条件 |
| `src/main/capabilities/discovery-service.ts` + `sources/` | 联网检索适配器、去重、候选来源与缓存 |
| `src/main/capabilities/acquisition-service.ts` | 接入计划、版本固定、事务日志、激活与回滚 |
| `src/main/mcp/connection-manager.ts` | 会话、生命周期、认证引用、断线处理 |
| `src/main/mcp/tool-service.ts` | list / describe / call、schema 校验、结果转换 |
| `src/shared/capabilities.ts` | 类型与错误枚举 |
| 渲染端设置「能力」页 | 内置 / Skill / MCP 分组 + 搜索源 + 自动接入策略；pi 包操作复用 `packages.ts` |

**桥接边界**：渲染端只能经 preload + `shared/ipc` 调主进程。
新桥接绑定 `runnerId` / `generation` / `sessionId`；loopback 仅本机监听、每 runner 随机凭证、请求大小限制；
**不能**直接调用无身份的全局 active runner。凭证**不返回**模型文本、**不写**日志。
子代理继承受限能力集合与项目身份，**不复制**父 runner 的宽凭证；父任务停止时撤销其未执行请求。

## 4. 能力目录契约

```ts
type Capability = {
  id: string; kind: 'builtin' | 'skill' | 'mcp-tool';
  title: string; description: string; version?: string;
  source: { owner: 'yan' | 'user' | 'project' | 'package'; location: string };
  availability: 'ready' | 'disabled' | 'missing-dependency' |
    'needs-auth' | 'disconnected' | 'error';
  effect: 'read' | 'write' | 'external-action' | 'unknown';
  projectScope?: string;
  schemaRevision?: string;
}
```

- 稳定 ID：MCP 用 `serverId + toolName`，**不能仅以 `toolName`** 合并两家服务。
- `schemaRevision` 在参数定义变化时更新；旧版本调用返回**可重试的** `schema-changed`，不拿旧参数硬调。
- `effect` 由受信配置 / 已审查的能力描述约束；MCP 服务自报 `readOnlyHint` **不当作安全边界**。
- 来源声明由**宿主**赋予；第三方**不能**自称 `builtin`。
- 不同项目默认不可发现对方的私有服务 / Skill；跨项目授权必须明确登记；列表**不泄漏**另一项目的绝对路径。

## 5. MCP 接入

固定兼容版本并使用**官方 SDK**；具体包版本通过当前 lockfile 与 API 验证，**不照抄最新版本号**。

**stdio**

- `command` / `args` **数组**执行，**禁止**把模型字符串拼成 shell；`cwd` 与环境由配置限定。
- 进程 `stdout` 只解析协议；`stderr` 有界日志；启动超时、退出码、重连状态可见。
- 显式构建子进程环境；认证只引用凭证存储，**不**把宿主全部秘密环境无差别传给服务器。
- 关闭连接后释放子进程与订阅，**不误杀**其它用户进程。

**HTTP**

- 首版支持手动配置或经接入计划核实的自动登记端点，以及安全存储的 token / header 引用；
  需要 OAuth 但未实现时显示 `needs-auth`，**不能伪装已连接**。
- **不把凭证放 URL**；跨源跳转**不携带**原认证头。
- 配置端点与「模型指定任意 URL」**分离**；模型不能绕过登记去连任意地址。
- 处理会话失效、连接超时、服务端重启与版本协商；**握手成功 ≠ 工具调用成功**。

**调用**

- `tools/list` 分页与变更通知更新目录；不支持通知时在重连 / 显式刷新时更新。
- 校验 `inputSchema`；`tool error` 与 `transport/protocol error` **分开显示**。
- 文本、结构化输出、图片、resource link **分开转换**；MIME 与大小受限，落盘到隔离附件目录。
  **资源链接不自动取得读取权限。**
- 超时建议：只读 60s、长操作可配置 300s；用户停止发送取消；
  远端取消**不保证**外部动作未完成，应报告状态未知。
- 只读请求可做有限退避；**写操作发送后断线不自动重放**。
  `operationId` 只有服务器支持幂等时才可当成防重复保证。
- 连接配置在 `YAN_DIR`，凭证在可用的系统安全存储；
  系统存储不可用时**明确显示限制**，**不明文悄悄降级**。安装包与便携版分别验证凭证生命周期。

## 6. Skill 发现、选择与执行

- 既有资源以**实际 pi 加载列表**为真源；新增砚受管资源以通过激活校验的 **receipt** 为真源；
  二者合并进统一目录，并按**真实路径 / 内容身份**去重。
- 保持用户 / 项目 / 包启用规则、同名冲突提示与来源；受管资源**不冒充** pi 已加载资源。
  **不能**扫描全盘 `SKILL.md` 后全部开放。
- 描述质量：说明适用目标、输入输出与依赖；拒绝空 `description`。
- 正文**按需加载**，记录内容 hash；正文变化后当前任务再使用须**重新读取**。
  名称相同但来源不同 → 用稳定 ID 选择。
- **Skill 不是可调用 API**：读取后由模型用现有工具 / 脚本按流程执行。
  脚本依赖缺失报 `missing-dependency`，**不把「读到了技能」当成功**。
- 模型可自主选用已启用能力；不足时自动进入 §7 的联网发现。
- MCP description、Skill 正文、检索结果都是**不可信材料**：不能修改系统规则、授权范围，
  也不能让工具读取其它项目凭证。

## 7. 联网发现

### 7.1 触发与完整路径

```text
用户目标 → 查现有能力 → 足够则直接执行
                     ↓ 缺少能力 / 现有能力不适用
                 联网搜索候选
                     ↓
            核实来源、内容和运行要求
                     ↓
            生成固定版本的接入计划
                     ↓
          按策略自动安装或登记远程连接
                     ↓
           验证 → 激活 → 继续同一目标
```

- 触发依据是**具体能力缺口**（例：「能读表格，但没有读取该业务系统的入口」），
  **不**因为用户目标较大就搜索安装一堆包。
- 已有能力完成不了时，联网检索**无需再问**一句「要不要帮你搜索」。
  设置可关闭联网发现；关闭时准确说明限制。
- 检索词使用必要的通用任务描述，默认**不带**私人项目名、用户文件正文、密钥或内部地址；
  本地搜索与向远端发检索词分开记录。用户任务明确需要远程数据时，数据发送范围仍由任务授权决定。

### 7.2 搜索源适配器

统一返回：可用性、分页、限流、缓存、来源 URL、抓取时间。**先查结构化目录**，不假设任意网站都有 API。

| 对象 | 首版接入方向 | 必须满足 |
|---|---|---|
| Skill | pi 包目录、npm 的 pi 包元数据、来源仓库的 `SKILL.md` / 资源声明 | 查到目录后**回读确切版本的文件**，确认不是只有一个同名 README |
| MCP | 兼容官方 Registry schema 的目录 / 聚合服务、发布方官方仓库或文档 | 取得真实 server 元数据、包来源或远程 endpoint、传输、认证、平台要求 |
| 长尾候选 | 已配置的网页搜索服务，必要时用已有浏览器读官方页面 | 返回**原始来源链接**；搜索摘要只是线索，**不能直接变成安装命令** |

**硬要求**

- **发现能力必须随砚提供**，不依赖「先搜索并安装一个搜索 Skill」才可工作。
- 新安装环境至少有一条 **Skill** 联网检索路径和一条 **MCP** 联网检索路径可用。
  优先公共目录的已验证查询接口；通用搜索 provider 作为补充，**密钥缺失时仍能做目录检索**。
- 目录源全部不可用 → 显示「暂时无法搜索」，**不返回模型编造的包名**。
- 可配置 `sources` 的 endpoint、类型、认证、缓存期限。每轮默认最多**两次查询改写**、
  每源最多**两页**、候选最多**八项**；只有新信息才扩大范围；遵守源限流并支持取消。
- 官方 MCP Registry 当前标为 preview，首版需选择并**验证一个真实可用的兼容目录**，
  或提供有缓存的元数据适配层，**不能**给每个模型请求无界抓全库。目录只证明发布来源，**不等于**代码已被安全审计。

## 8. 候选、接入计划与评估

```ts
type CapabilityCandidate = {
  candidateId: string; kind: 'skill' | 'mcp-server';
  title: string; summary: string;
  discoveredAt: string; sourceUrls: string[];
  publisher?: string; repository?: string;
  version?: string; commit?: string; integrity?: string;
  transport?: 'stdio' | 'streamable-http';
  requirements: string[];
  auth: 'none' | 'configured' | 'required' | 'unknown';
  installKind: 'skill-files' | 'pi-package' | 'mcp-package' | 'remote';
  verification: 'metadata-only' | 'source-checked' | 'smoke-passed';
};
type AcquisitionPlan = {
  planId: string; revision: number; candidateId: string;
  goalId: string; projectId: string;
  pinnedSource: string; artifactDigest?: string;
  scope: 'project-managed';
  filesAndDependencies: string[];
  needsRestart: boolean;
  policyResult: 'automatic' | 'needs-auth' | 'needs-authorization' | 'unsupported';
};
```

- 候选目录与「可用能力目录」**分开**；只有激活与验证完成才成为 `ready`。
- 排名考虑：目标匹配、能否在 Windows / 当前运行时执行、认证是否已有、维护与许可信息、所需权限、接入代价。
  **下载量不是可信证明。**
- 模型解释选中理由；主进程负责结构校验、来源一致性与执行策略，**不让模型直接决定安装 shell 字符串**。
- 源内容变化导致 digest / revision 改变时，旧计划**失效**。
- 固定 npm 精确版本、Git commit 或其它不可变 artifact；
  检查同名仿冒、原仓库与包元数据关系、协议 / 依赖兼容。**不因为搜索结果第一名就自动执行。**
- 安装器返回实际文件与依赖清单、日志摘要、失败阶段；
  `metadata-only` **不得**显示「已经验证」；来源无法核实时可给候选说明，**不能捏造 verified**。

## 9. 自动接入策略与认证

- 默认策略建议：**「自动搜索 + 在已授权来源和权限范围内自动接入」**。
  设置可切换「仅已有 / 搜索并推荐 / 自动接入」；当前需求的验收用**自动接入档**，
  **不把推荐列表当最终交付**。
- 已启用的发布者 / 来源范围、可用的本地运行时、项目级读写权限、外发范围组成**持久策略**；
  不是每次都弹一次许可。
- 纯 Skill 文件可先下载到 **staging** 做内容核查；任何脚本执行或额外依赖安装都纳入接入计划。
  **Skill Markdown 能引导后续工具行为，不能把「只是文本」当自动安全结论。**
- 满足策略、固定版本且依赖齐备的候选**自动接入、测试并继续**，不要求用户复制命令。
- 新来源超出策略、系统级依赖 / 提权、缺账号或额外费用时，**只请求这一项缺失条件**，
  展示具体能力、来源、范围和原因。不泛化为每个工具都需确认，也不把网络目录的描述当用户授权。
- 已有认证仅在同一授权服务 / 账号范围内复用；不把其他服务 token 复制给新 endpoint。
  **凭证进入安全存储，不进入 prompt 或 Skill 文件。**
- 远程 MCP 无需本地安装时直接走「验证端点 → 登记配置 → 连接 → 枚举工具」；
  **不能为了统一界面伪造下载步骤。**
- 手动 token / header 为基础路径；OAuth 型服务若没实现授权回调，**准确保持 `needs-auth`**。
- 工作模式不改变授权范围：澄清模式可联网检索元数据，但**不执行安装或写操作**；
  需求就绪后转标准再接入。自主模式自动尝试策略允许的替代候选。

## 10. 接入事务、生效与继续

**状态机**：`discovered → inspected → prepared → acquiring → verifying → activated → resumed`，
另有 `needs-auth` / `needs-authorization` / `pending-boundary` / `failed` / `cancelled`。
主进程持久化 `operationId`、`planRevision`、`runner/generation`、`goal/sourceHead`、已下载文件与恢复点；
`acquire` 重试使用**同一个** `operationId`，不能多次安装同一候选。

> **远程 MCP 那条路已落地（S6b-1，2026-09-20）**：`installKind: 'remote'` 分支现在是**真登记**，
> 不经过下载器（§10 原文就是「不能为了统一界面伪造下载步骤」）：
> `capabilities.acquire --plan <ID> [--authorize]` —— `metadata-only` 候选默认停在 `needs-authorization`（目录只是线索）；
> `--authorize` 记下 **host 级持久授权**（不记凭证、跨项目隔离）后，宿主真连端点核验 → 原子写
> `YAN_DIR/mcp-servers.json` → 写受管记录（`capabilities/mcp-managed.json`）→ `resumed`；
> 核验失败**一个字节都不写**，同名不同端点**拒绝覆盖**；登记后能力目录**当场可见**
> （`mcpManager` 失效重建，无需重启），同一计划重放只复核不重复登记。
> **S6b-2 当前状态（2026-09-21）**：npm `pi-package` 下载 / 调度已接 Electron runtime adapter；本地 Pi smoke 使用临时、离线、无工具 / 无会话 / 无凭证环境；相对资源路径 glob、globstar 与 `!` 排除已实现并以离线 Pi fixture 验证。staging 的 hash manifest 复核现会拒绝未登记 / 缺失文件、符号链接与特殊文件。**`mcp-package` 本轮已接通**：精确 npm staging、包内 `bin` 解析、官方 SDK `tools/list` smoke、项目范围 stdio 配置的原子登记 / 受管记录 / 复核 / 幂等重放；stdio 子进程环境采用 allowlist 加显式配置变量。**固定项目内 `skill-files` 的安全生效边界也已接通**：acquire 只写受管 staging 并绑定 `runnerId + generation + cwd + projectId + goalRevision + sourceHead + continueId`，当前回合结束后由单飞调度器在 runner 空闲、信任 / 来源 / 目标仍匹配且凭证可用时复核 manifest、物化 active 文件、重建同一 runner，并验证 `--skill` 路径、续接 ID 与 `resumed` 回执；忙碌 runner 只延后，不重启无关实例。**独立 Skill 来源边界已补齐**：可选目录适配器现在兼容 SkillMD 风格的 `items` 列表，先从同源详情固定 commit，再从同源 raw URL 读取正文并计算 SHA-256；接入时仍通过来源白名单、HTTPS、UTF-8 / 大小 / 跳转 / hash 复核，再复用现有 Skill staging 与安全激活边界。真实 `skilldirnet` 已取到外部目录候选并通过只读发现证据；未获授权外部候选的整链验收仍待做。历史事务可能停在 `pending-boundary`，不是此类候选的全局终态。

> **S7 当前状态（2026-09-21）**：主要实现与真实运行接线已完成：能力设置页展示内置能力、已加载 Skill、MCP 服务与用户触发的目录搜索；模式策略为「仅现有能力 / 搜索并推荐 / 自动接入」，策略在主进程执行；MCP 私有服务按 runner 的项目身份过滤，无身份 fail-closed；MCP 核验只在用户点击后发生，取消绑定 `runnerId + generation + operationId`，迟到握手不能恢复已取消连接。`capsettings`（包括设置页、安全快照、核验 / 取消 / ready 状态）、`mcpcli`、`capcli` 真实运行通过，单测为 **4158/4158**，`typecheck` / `build` 通过。`visual:matrix` 已生成并看图核对深 / 浅主题能力页（策略、能力目录、Skill、MCP 服务状态卡），4 张截图溢出均为 `0px`。`dist:dir` + `test:packaged` 已在解包、便携版和全新 NSIS 安装后 EXE 中取得完整运行探针；包形态不再是当前限制。真实外部 Skill 目录只读发现已由 `skilldirnet` 取得证据；当前仍未获授权真实外部候选从 acquire → 安装 → runner 激活 → 原目标续接的整链证据。

> **S6b-2 自动证据（登记时）**：本轮最新 `typecheck` / `build` / 单测为 **4149/4149**；新增 staging manifest 精确文件集真文件回归，以及 `mcp-package` 的临时 npm 包解析 / 官方 SDK `tools/list` / stdio 登记复核、受保护环境变量拒绝与超时清理回归。本地 Pi 自写 fixture 真实启动 RPC 并通过 glob + `!` 排除加载、`session_start`、环境变量隔离。生产适配已接精确授权 / 持久信任 / `pi install -l` / 项目清单 / 目标 runner / 原目标续接端口；没有真实外部候选 acquire、安装、激活、续接或包内证据，详见 [技术预检 §6](../../archive/evidence/证据-04-S6-技术预检.md)。未随 tarball 提供的依赖仍 fail-closed。

1. 在 `YAN_DIR` 的受管 staging 目录下载，**不往项目根或用户真实技能目录散落文件**。
2. 校验 archive 路径、大小、文件数量、符号链接、hash 与来源；拒绝路径穿越与解压膨胀。
3. 首版自动接入覆盖：Skill 文件、已验证的 pi npm / git 包、本地已有 Node 环境可运行的 MCP 包、远程 HTTP MCP。
   Python / uv、容器等在环境已有且接入器验证通过时可扩展；未实现时**明确 `unsupported`**，
   **不静默安装全局运行时**。
4. 依赖与生命周期脚本按策略执行，**先检查后执行**；禁用脚本若影响功能应**如实失败**，
   不能把「安装退出码 0」当可用。**包和服务器会执行本机代码，不宣称 staging 是安全沙箱。**
5. 隔离测试注册 / 读取 / 握手及**无副作用** smoke；遇无只读工具的 MCP 仅验协议可达，
   业务调用待授权任务执行，**不能随意调用写工具「测试」**。
6. 原子登记能力及 receipt，激活成功后**继续原 goal**；失败只清理本次受管 staging / 依赖，
   **不碰**用户已有安装。

**pi 项目资源信任边界（2026-09-20 实测修订）**：`pi install <source> -l` 在未信任项目会拒绝写 `.pi/settings.json`；`--no-approve` 同样不能完成安装，`--approve` 则是单命令的项目资源信任覆盖，不可由自动接入器暗中追加。安装前检查 pi `trust.json` 的**持久项目级信任**；若尚未信任，授权对话框必须明确说明这会信任该项目当前及未来的 `.pi` 设置、扩展与技能（范围大于单个候选），由用户明确选择后才写信任并继续。最终命令仅由宿主构造为 `pi install <verified-path> -l`，不使用两个信任覆盖标记；信任状态无法确认或持久化失败时 fail closed。隔离实测与适用限制见[技术预检](../../archive/evidence/证据-04-S6-技术预检.md) §2。

### 10.1 与 pi 包管理、运行中任务的冲突

现有 `packages.ts` 在目标目录有任务运行时拒绝装卸，且扩展在**启动时**加载。
**不得删除这道检查来实现自主安装。** 按资源类型处理：

| 资源 | 处理 |
|---|---|
| 普通 Skill 文件 | 砚受管目录按项目隔离，由 `skill-service` 按固定版本读取；**不要求**动态注入任意 pi 扩展；刷新能力目录即可；不重复列出同一 Skill |
| MCP 独立进程 / 远程连接 | 由砚宿主启动 / 连接，通过 `yan mcp` 调用；**不需要**每发现一个 MCP 就给 pi 装一个新扩展 |
| 确实需要 pi 包的候选 | 保存接入计划，返回 `pending-boundary`；当前轮**安全结束后**由调度器进入安装 / 重载；**不能**在 `acquire` 内部等「当前回合结束」，否则互相等待死锁 |
| 共享包目录 | 检查所有受影响 runner；**不中断**无关任务或更新它正在使用的依赖。优先项目受管目录固定版本并存；无法安全隔离则等明确空闲或选替代候选 |

- 使用**同一** `resolvePi` 与 `PI_AGENT_DIR`，**不出现**装到 A、运行 B。
- pi 项目包安装只允许在项目已持久信任后进行；安装命令不得靠 `--approve` / `--no-approve` 覆盖信任状态。
- 安装后的资源重载 / 重建必须验证 `session`、队列、模式、模型、文件引用不丢。
- 纯 Skill 与宿主 MCP **至少各有一条**无需用户手动新建会话的闭环。
- pi 包若需要重启：保存 `sourceHead` 与 `continueId`，以既有会话重建 + 一次性内部继续完成；
  运行时无法安全支持时，**不能**把「下次启动可用」算成自动继续已验收。

### 10.2 恢复与停止

- 用户停止即取消未执行步骤与自动续行；已安装资源可保留为**未启用**，不自动执行。
  后续用户继续时**复查原目标及计划**是否仍有效。
- 失败**不自动**改为「更新所有包」；写操作断线不重复执行。
- 自动尝试最多**两个**不同候选、每个接入事务**一次**正常重试；无新证据则说明失败与替代路径。
- 崩溃恢复校验 receipt、文件 hash、实际连接与继续消费证据；
  **不以「事务记录写过 `activated`」替代真资源检查**。`continueId` 已消费则不再次发同一任务。

## 11. 用户可见状态与资源生命周期

- 目标执行时间线：「正在找合适能力 → 找到候选及选择原因 → 接入中 → 测试中 → 已用于任务」；
  缺认证和不支持平台给**具体条件**。**不要**只弹「插件安装成功」就结束当前目标。
- 能力页展示：来源链接、固定版本、安装范围、真实可用性、最近验证、谁 / 哪个任务引入、磁盘占用；
  用户可禁用 / 移除，正在使用时在安全边界处理。
- 默认**项目受管**安装，重复任务复用相同版本，**不每次重新联网安装**。
  更新走单独事务，保留在用版本；停止 / 失败不删除用户文件，卸载仅删除**砚登记拥有的**资源。
- 搜索缓存带时间与来源标记；离线时可用已验证的本地能力，**不能**把缓存候选标为「当前已联网验证」。
  搜索源不可用、限流、解析失败**分别显示**，用户不必重述原目标。

## 12. 会话切片

| 片 | 内容 | 规模 | 出口 |
|---|---|---|---|
| **S1** | C0 技术预检：实际 pi 版本、依赖锁定版本、工具注册、动态启用、技能发现、RPC 可用接口、SDK 版本；**可复用 [01](实施-01-默认pi架构迁移.md)-S1 的加载清单结果** | 0.5 天 | 固定基础版本与命令面；记录每项可实现 / 有限 / 缺接口 |
| **S2** | C1 目录与来源 + 已装 Skill | 1 天 | 用**真实模型**证明按目标读取正确技能并有产物验证 |
| **S3** | C2 MCP 连接：本地 stdio fixture + 远程 HTTP fixture | 1–1.5 天 | 握手、分页、schema、认证失败、结果格式；`tool error` 与协议错误分开 |
| **S4** | C3 模型发现 → `describe` → `invoke` → 验证完整链 | 1 天 | 工具不直接出现在初始 prompt 也能用 |
| **S5** | C4 联网发现适配器、候选来源、排序与接入计划 | 1–1.5 天 | **真实目录检索证据**（不能只用 fixture 断言排名） |
| **S6** | C5 自动下载 / 安装 / 连接、隔离验证、运行中安全激活、继续原任务 | 1–2 天 | 无死锁、队列 / 会话不丢、其他 runner 不被重启、`continueId` 仅消费一次 —— **S6a（接入事务内核 + 受管 staging）已完成（2026-09-20）**：状态机与合法迁移 / 归档上限与路径校验（路径穿越·绝对路径·symlink·解压膨胀）/ 确定性 `operationId`（重试复用同一事务，≤2 次）/ receipt / 恢复复核**重算 hash 而不看日志**；`AcquisitionService` 受管落盘（`YAN_DIR/capabilities/staging/<operationId>`）失败只清本次；`capabilities.acquire` 已接通（策略判定 → `needs-auth` / `needs-authorization`，自动档建事务并停在 `pending-boundary`）。**剩 S6b：下载器 / `pi install` / 远程 MCP 登记 / 隔离冒烟 / 运行中激活 / 原目标续接（本片一行未碰网络与安装）** —— **S6b-1 已完成（2026-09-20）**：**远程 MCP 自动登记闭环**（§10「不伪造下载步骤」那条路）—— 新增 `src/shared/mcp-registration.ts`（端点选取 / 服务 ID / 配置草案与 URL 安全 / 授权匹配）与 `src/main/capabilities/registration-service.ts`（真连核验 → 写 `YAN_DIR/mcp-servers.json` → 受管记录：失败只清本次、核验失败一个字节不写、同名不同端点拒覆盖、`authorizations.json` 持久策略）；`AcquisitionService` 加 `markAcquiring/markVerifying/markResumed` 与可注入 `verify`（远程走「再连一次」而不是 staging hash）；`capabilities.acquire` 分三档，远程分支**真登记** + `--authorize`，登记后**当场可见**；候选新增显式 `remoteUrl`（不再从 `sourceUrls` 猜端点）。审证：单测 **+58**（**3948 全绿**）、新场景 `mcpregister`（cost 0，已进 `check`）+ `capcli` / `mcpcli` 回归绿、反向验证 4 条红。**剩 S6b-2：下载器 / `pi install` / 本地 MCP 包 / Skill 文件（仍停 `pending-boundary`）**；技术预检（落点与信任边界）见 [证据-04-S6](../../archive/evidence/证据-04-S6-技术预检.md) |
| **S7** | C6 模式限制、项目隔离、取消 / 重连、视觉与包 | 1 天 | 见 §13；六栏齐备 |

**只做 S2–S4 不算完成本方案**（那只覆盖「现有能力自动选用」，缺「缺失能力联网补齐」）。

## 13. 验收

### 13.1 新增测试用例

两个同名工具｜过期 schema｜伪造来源｜目录穿越｜恶意描述注入｜切项目迟到响应｜
超大结果｜断线后写操作不重放｜禁用后缓存失效。

### 13.2 真实模型（cost 1）

至少三例：**只需 Skill**、**需 MCP 查询**、**Skill + MCP 组合**。
另做无匹配、缺认证、误选后纠正。**不得只用固定 mock 选工具**证明模型自主选择。

### 13.3 分阶段必做表

| 场景 | 通过标准 |
|---|---|
| 干净环境缺 Skill | 模型按目标联网找到初始目录中**不存在**的 Skill → 读取固定来源 → 接入 → 真执行并验证产物；用户未提供包名 |
| 干净环境缺 MCP | 模型找到未配置服务 → 生成计划 → 启动本地服务器或登记真实远程端点 → `tools/list` / `call` → 完成原目标 |
| 无通用搜索密钥 | Skill / MCP **至少一条**目录检索路径仍可用，无「先装搜索插件才能搜索」的循环依赖 |
| 安装需要安全边界 | 当前工具不死锁，队列 / 会话不丢，其他 runner 不被重启，`continueId` 仅消费一次 |
| 缺认证 / 不支持平台 | 不报 `ready`，不造结果；说明确切缺口，自动尝试可用替代能力 |
| 来源变化与恶意内容 | plan hash 变化失效；README 注入不改变授权；压缩包越界被拒；`unknown` 工具不绕过模式门禁 |
| 失败 / 停止 / 重启 | 不留半登记的 `ready` 项，不重复安装 / 外部写 / 续行；原目标和历史可恢复 |
| 缓存与卸载 | 复用正确版本，禁用后**下一请求**不可调用；只清除受管资源 |

**取证口径（不能互相替代）**：从「确认未安装 / 未配置」的状态开始，
收集搜索结果 → 安装 receipt → 实际调用 → 产物 → 原目标验收，六个阶段。
**不得预装目标能力后宣称验过「自行发现并安装」。**
协议故障 / 下载故障用 fixture；**联网发现成功**必须有真实目录检索证据；
**模型自主选择**必须有真实模型证据。外部目录内容会变化，fixture **不断言**永久固定的排名 / 包名。

### 13.4 交付六栏

实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制。
完成必须覆盖「现有能力自动选用」与「缺失能力联网补齐」**两条主链**；
只展示搜索结果、安装按钮或已安装目录**不算完成**。

## 14. 回滚与接口

- `feature flag` 关闭能力代理，保留配置与结果；停止连接**不能**删除外部资源；目录索引可重建。
- 文档同步：更新 PROJECT、CODE-MAP、TESTING、HANDOFF；
  **标出实际支持的传输与认证方式**，**不写「支持任意 MCP」**。

| 依赖方 | 接口 |
|---|---|
| [01 架构迁移](实施-01-默认pi架构迁移.md) | 提供 `yan` CLI、宿主服务骨架、结果文件、能力获取分流规则（§8） |
| [02 任务](../../archive/plan/实施-02-任务工具内置化-已完成.md) | 提供 `builtin` 来源 |
| [03 项目知识](../../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md) | 提供项目知识检索（登记为 `builtin`） |
| [05 模式](../../archive/plan/实施-05-工作模式与长任务续接-已完成.md) | 提供模式快照 / 执行门禁 / 总预算；**模式门禁必须在真实执行入口施加**，此文档的模式限制不能只靠目录隐藏 |

**共同使用**：`RuntimeEnvelope`、`schemaVersion`、来源 provenance、有限预算；
**不要**分别创建全局 `activeProject` 单例绕过 runner。
