# C · 模型自主搜索、接入与使用 MCP 和 Skill
> 面向实施 agent；2026-09-18；实施方案，尚未实施。
> **架构修订入口：** 用户新增“完成版只包含默认 pi、不内置 pi 插件”的边界。先读 [默认 pi 与砚原生能力层](架构修订-默认pi与砚原生能力层-2026-09-18.md)。本文涉及 pi 扩展注册、随包适配层和 pi 包自动接入的旧路径暂不执行；业务契约保留，按新方案迁移为宿主服务/CLI。新方案中的严格零扩展解释及现有功能等价性须按其边界说明处理。
> 本轮只编写计划，不连接外部账号、不安装 MCP/Skill、不修改用户配置。

## 1. 目标和已核实基础
用户只说目标，模型先选择现有能力；不足时**自行联网搜索 Skill/MCP、评估候选、按策略安装或连接、验证可用，然后继续原任务**。能说明所用能力、失败原因与结果证据。联网发现与自动接入是本方案必做范围，不能只交付本地目录查询。
先读 [HANDOFF](../dev/HANDOFF.md)、[TESTING](../dev/TESTING.md)、[agent.ts](../../src/main/agent.ts)、[packages.ts](../../src/main/packages.ts)、[command-registry.ts](../../src/main/command-registry.ts)。

现状：
- pi 启动有内置扩展入口，普通会话未传 no-skills；砚识别 skill 命令来源。
- packages.ts 通过 pi CLI 管理包，运行时装卸被拒，不意味着 MCP 服务已经连通。
- 在本次 src/resources 静态范围未找到完整 MCP 连接管理、工具发现与调用服务。实施前复核实际配置与依赖，不能据此断言用户所有第三方包都不具备 MCP。
- pi 最新文档描述 Skill 名称/说明常驻、正文按需读取；MCP 工具协议支持枚举与调用。**最新文档不是本机运行时版本承诺**。

交付范围：已安装 Skill 的自动选用、已配置 MCP 的发现/调用，以及未安装 Skill/未配置 MCP 的联网搜索、评估、接入、验证、自动续行。账号注册、付费购买和远端基础设施部署不自动代办；缺这些条件时保留目标并准确报告。具体流程见 §11–§16。

### 1.1 pi 原生能力核查（2026-09-18）

本次读取仓库 resources/pi-runtime/package.json 与本机全局 @earendil-works/pi-coding-agent/package.json，两者均为 **0.85.1**；同时核对该全局包附带 README.md、docs/skills.md、docs/packages.md 与官方当前文档。未启动当前用户会话抓取实际 piBin；用户覆盖运行路径时，实施 agent 必须再通过 protocol.ts 的 resolvePi 核实，不能把包文件版本当正在运行实例的证据。

| 能力 | 核查结论 | 砚应如何处理 |
|---|---|---|
| 发现已配置路径/包中的 Skill，按任务读取正文 | pi 原生支持；先读取名称说明，再按需加载 | 复用，不重写 Skill 标准 |
| 安装已知 npm/git/本地来源的 pi 包 | pi 原生有 install/list/remove 等入口 | 复用版本相容的包管理；不等于模型已会联网找未知包 |
| 项目配置已经声明的缺失包在受信场景自动安装 | 官方包文档有此行为 | 属于恢复已声明依赖，不是按用户目标搜索新能力 |
| MCP 客户端/工具接入 | 本机 README 与官网均明确核心不内置 MCP | 由砚管理宿主或兼容适配器；第三方 MCP 扩展不等于 pi 原生 |
| 按目标联网检索未知 Skill/MCP，再自动接入、验证、续行 | 未发现 pi 原生完整工作流；官方提供 Skill、安装器和扩展基础 | 本方案补齐完整工作流 |

依据：[pi Skill 机制](https://pi.dev/docs/latest/skills)、[pi 包管理](https://pi.dev/docs/latest/packages)、[pi 核心边界](https://pi.dev/)。pi 包目录也存在第三方 MCP 适配器和网页搜索包，但目录存在不证明已经安装、兼容或可自动选用。[pi 包目录](https://pi.dev/packages)
模型借 bash 临时拼下载/安装命令可能做到其中某步，不等于宿主已有可观察、可恢复的产品能力；不将这种偶然路径作为验收。

## 2. 技术预检与固定决策
C0 必须记录实际 pi 版本、依赖锁定版本、工具注册、动态启用、技能发现、RPC 模式可用接口。
可参考 [pi Skills](https://pi.dev/docs/latest/skills)、[pi Extensions](https://pi.dev/docs/latest/extensions)。官方 API 可注册工具，但要在当前隔离版本上验证；不修改 resources/pi-runtime 生成物。
首版选择 **固定数量的能力代理工具 + 按需返回 schema**。这样不以“运行中动态注册任意工具”作为前置：
- capability_search：按目标查可用能力摘要。
- capability_discover：在已登记的联网搜索源查找尚未接入的候选，返回来源证据，不返回“已可用”。
- capability_prepare：按候选 ID 与固定版本生成接入计划和依赖清单，不执行任意网页命令。
- capability_acquire：提交宿主验证过的接入计划，按策略完成下载、安装或连接；可返回 pending/needs-auth 等状态。
- capability_operation：查询或取消已提交的接入事务，不能用重复 acquire 冒充轮询。
- skill_read：读取已登记 Skill 的正文和来源。
- mcp_describe：读取指定服务器工具的参数 schema。
- mcp_invoke：按已返回的工具身份、schemaRevision 与参数执行。

后续可增加原生动态工具暴露，但不能双注册同一能力。若当前 pi 已完整提供 Skill 按需读取，则复用其目录和 read 流程；skill_read 仅用于目录规模大、来源追踪/禁用约束需要时，不并行维护两份发现规则。

## 3. 宿主结构
拟新增：
- src/main/capabilities/catalog.ts：登记与过滤，不执行业务。
- src/main/capabilities/skill-service.ts：读取 pi 实际资源发现结果、校验路径与前置条件。
- src/main/capabilities/discovery-service.ts 与 sources/：联网检索适配器、去重、候选来源与缓存。
- src/main/capabilities/acquisition-service.ts：接入计划、版本固定、事务日志、激活与回滚。
- src/main/mcp/connection-manager.ts：会话、生命周期、认证引用、断线处理。
- src/main/mcp/tool-service.ts：list/describe/call、schema 校验、结果转换。
- src/shared/capabilities.ts：类型与错误枚举。
- resources/pi-extensions/capabilities.js：固定代理工具和最小路由提示。
- 渲染端设置中的“能力”入口：内置、Skill、MCP 分组，加搜索源与自动接入策略；pi 包操作复用 packages.ts，受管 Skill 文件和独立 MCP 运行目录由 acquisition-service 管理。

渲染端只能经过 preload + shared/ipc 调主进程。pi 扩展到宿主可复用已有浏览器桥接的设计经验，不能复用它的宽权限端点。
新桥接绑定 runnerId/generation/sessionId，loopback 仅本机监听、每 runner 随机凭证、请求大小限制；不能直接调用无身份的全局 active runner。凭证不返回模型文本、不写日志。
子代理继承受限的能力集合与项目身份，不复制父 runner 的宽凭证；父任务停止撤销其未执行请求。

## 4. 能力目录契约
~~~ts
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
~~~
稳定 ID 对 MCP 使用 serverId + toolName，不能仅以 toolName 合并两家服务。schemaRevision 在参数定义变化时更新；旧版本调用返回可重试的 schema-changed，不拿旧参数硬调。
effect 由受信配置/已审查能力描述约束；MCP 服务自报 readOnlyHint 不当作安全边界。来源声明由宿主赋予，不能让第三方自称 builtin。
不同项目默认不可发现对方的私有服务/Skill；跨项目授权必须明确登记。列表不能泄漏另一项目的文件绝对路径。

## 5. MCP 接入实现
参考 [工具协议](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[传输协议](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)，实现时固定兼容版本并使用官方 SDK，具体包版本通过当前 lockfile 与 API 验证，不照抄最新版本号。

stdio：
- command、args 数组执行，禁止把模型字符串拼为 shell；cwd 与环境由配置限定。
- 进程 stdout 只解析协议，stderr 有界日志；启动超时、退出码和重连状态可见。
- 显式构建子进程环境，认证只引用凭证存储，不把宿主全部秘密环境无差别传给服务器。
- 关闭连接后释放子进程与订阅，不误杀其它用户进程。

HTTP：
- 首版支持手动配置或经接入计划核实的自动登记端点，以及安全存储的 token/header 引用；需要 OAuth 但未实现时显示 needs-auth，不能伪装已连接。
- 不把凭证放 URL；跨源跳转不携带原认证头。配置端点与模型指定任意 URL 分离，模型不能绕过登记去连接任意地址。
- 处理会话失效、连接超时、服务端重启和版本协商；连接成功后再 tools/list，握手成功不等于工具调用成功。

调用：
- tools/list 分页与变更通知更新目录；不支持通知时在重新连接/显式刷新时更新。
- 校验 inputSchema；tool error 与 transport/protocol error 分开显示。
- 文本、结构化输出、图片、resource link 分开转换；MIME 和大小受限，落盘到隔离附件目录。资源链接不自动取得读取权限。
- 超时建议只读 60s、长操作可配置 300s，用户停止发送取消；远端取消不保证外部动作未完成，应报告状态未知。
- 只读请求可做有限退避；写操作发送后断线不自动重放。operationId 只有服务器支持幂等时才可当成防重复保证。

连接配置在 YAN_DIR，凭证在可用的系统安全存储；系统存储不可用时明确显示限制，不明文悄悄降级。安装包和便携版分别验证凭证生命周期。

## 6. Skill 发现、选择和执行
既有资源以实际 pi 加载列表为真源，新增砚受管资源以通过激活校验的 receipt 为真源，二者合并进入统一目录并按真实路径/内容身份去重。保持用户/项目/包启用规则、同名冲突提示与来源；受管资源不冒充 pi 已加载资源。不能扫描全盘 SKILL.md 后全部开放。
描述质量要求：说明适用目标、输入输出与依赖；拒绝空 description，兼容规则按实际版本执行。
Skill 正文按需加载，记录内容 hash；正文变化后当前任务再使用须重新读取。名称相同但来源不同使用稳定 ID 选择。
Skill 不是可调用 API；读取后由模型使用现有工具/脚本按流程执行。脚本依赖缺失报 missing-dependency，不把“读到了技能”当成功。
模型可自主选用已启用能力；不足时自动进入 §11 的联网发现，满足接入策略的候选自动安装/连接，不把所有新能力都交回用户手动安装。缺认证、超出既有授权等具体条件按 §13 处理。
MCP description、Skill 正文、检索结果都是不可信材料；它们不能修改系统规则、授权范围或让工具读取其它项目凭证。

## 7. 自主选择策略
最小流程：
1. 根据目标列必要能力；用户明确指定的已可用能力优先。
2. 优先足以完成目标的内置/本地能力；需要外部数据再找已连接 MCP。
3. capability_search 查现有目录；能力缺失或不适用时调用 capability_discover 联网搜索（建议 top 8），经 prepare/acquire/verify 后才进入可用目录。
4. Skill 按需读全文；MCP 先 describe 再 invoke。
5. 验证交付物或服务端结果；工具返回“成功”不替代目标验收。
6. 一次明确失败后可以选不同路径；同一原因连续两次且无新信息则停止空转并汇报。

预算建议：目录摘要最多 1.5k tokens，单次 Skill 正文默认 6k、超出按章节读取；MCP schema 总量默认 4k；工具大结果使用有界摘要和原文引用。具体数值是首版配置，不是固定产品保证，统一计入方案 D 的预算。
有几百个 Skill 时不得一边声称按需发现一边继续让 pi 将全部描述注入；先测量实际 prompt，再决定受支持的目录过滤路径，记录动态变化对缓存的影响。

## 8. 模式、权限和可见性
标准模式按需选择；澄清模式仅开放经宿主确定的读取/查询能力，unknown 默认不在只读集合；自主模式在已有授权范围内组合与重试。
关掉 write/edit 不代表澄清只读，bash/脚本/第三方扩展也能写。模式工具限制必须在真实执行入口施加，不仅在目录隐藏；未纳入管控的直接扩展工具是明确缺口。
界面显示“已选择能力”“实际调用”“结果/错误”三个不同阶段；只连接成功不能显示已完成任务。
提供服务连接测试、能力可用性、来源、禁用、重新连接和最近错误。一般工具调用不重复弹无意义确认，确需新授权时明确指出缺口。
非本系统管理的第三方扩展不能被虚假标注为沙箱隔离。

## 9. 分期与测试
C0：本机 API 探测，固定基础版本和代理工具方案。
C1：目录和来源、已安装 Skill；用真实模型证明按目标读取正确技能并产物验证。
C2：本地 stdio fixture + 远程 HTTP fixture；验证握手、分页、schema、认证失败、结果格式。
C3：模型发现 → describe → invoke → 验证的完整链；工具不直接出现在初始 prompt 也能用。
C4：联网发现适配器、候选来源、排序与接入计划。
C5：自动下载/安装/连接、隔离验证、运行中安全激活和继续原任务。
C6：模式限制、项目隔离、取消/重连、视觉和包；具体新增验收见 §16。只做 C1–C3 不算完成本方案。

新增测试：两个同名工具、过期 schema、伪造来源、目录穿越、恶意描述注入、切项目迟到响应、超大结果、断线后写操作不重放、禁用后缓存失效。
真实模型 cost 1 至少三例：只需 Skill；需 MCP 查询；Skill + MCP 组合。另做无匹配、缺认证和误选后纠正；不得只用固定 mock 选工具证明模型自主选择。
不以每个测试都联网作为要求：协议故障用本地 fixture；最终选一项用户已授权的真实服务验连接/调用，否则记录外部限制。
先 build 后测试；包中没有开发依赖也能运行 SDK/适配层。六栏验收与 HANDOFF 写证据。

## 10. 回滚与跨方案接口
feature flag 关闭能力代理，保留配置和结果；停止连接不能删除外部资源。目录索引可重建。
[方案 A](实施方案-A-任务工具内置化-2026-09-18.md) 提供 builtin 来源；
[方案 B](实施方案-B-旧记忆清理与项目记忆-2026-09-18.md) 提供项目知识检索；
[方案 D](实施方案-D-工作模式与长任务续接-2026-09-18.md) 提供模式快照/执行门禁/总预算。
共同使用 RuntimeEnvelope、schemaVersion、来源与有限预算；不要分别创建全局 activeProject 单例绕过 runner。
更新 PROJECT、CODE-MAP、TESTING、HANDOFF，标出实际支持的传输与认证方式，不写“支持任意 MCP”。

## 11. 联网发现：在现有能力不足时主动寻找

### 11.1 触发与完整路径

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

触发依据是具体能力缺口，例如“能读表格，但没有读取该业务系统的入口”，不能仅因为用户目标较大就搜索安装一堆包。已有能力完成不了时，联网检索无需再问一句“要不要帮你搜索”。设置可关闭联网发现，关闭时准确说明限制。

检索词使用必要的通用任务描述，默认不带私人项目名、用户文件正文、密钥或内部地址；本地搜索和向远端发检索词分开记录。用户任务明确需要远程数据时，数据发送范围仍由任务授权决定，不由搜索结果决定。

### 11.2 搜索源与基础能力

实现“搜索源适配器”，将可用性、分页、限流、缓存、来源 URL 和抓取时间统一返回；先查结构化目录，不假设任意网站都有 API。

| 对象 | 首版接入方向 | 必须满足 |
|---|---|---|
| Skill | pi 包目录、npm 的 pi 包元数据、来源仓库的 SKILL.md/资源声明 | 查到目录后回读确切版本的文件，确认不是只有一个同名 README |
| MCP | 兼容官方 Registry schema 的目录/聚合服务、发布方官方仓库或文档 | 取得真实 server 元数据、包来源或远程 endpoint、传输、认证和平台要求 |
| 长尾候选 | 已配置的网页搜索服务，必要时使用已有浏览器读取官方页面 | 返回原始来源链接；搜索摘要只是线索，不能直接变成安装命令 |

官方 MCP Registry 提供服务器元数据和安装/配置描述；当前文档标为 preview，并建议宿主通过下游目录消费。首版需选择并验证一个真实可用的兼容目录，或提供有缓存的元数据适配层，不能给每个模型请求无界抓全库。目录只证明发布来源，不等于代码已被安全审计。[MCP Registry 说明](https://modelcontextprotocol.io/registry/about)

砚当前只有 pi 包网站入口不等于具有结构化搜索接口。C0 必须验证各候选源的真实检索/分页方式、访问限制和协议；没有稳定接口的站点仅作浏览回退，不能虚构 JSON endpoint。

**发现能力必须随砚提供，不依赖先搜索并安装一个“搜索 Skill”才可工作。** 新安装环境至少有一条 Skill 联网检索路径和一条 MCP 联网检索路径可用。优先公共目录的已验证查询接口；通用搜索 provider 作为补充，密钥缺失时仍能做目录检索。若目录源全部不可用，显示暂时无法搜索，不返回模型编造的包名。

可配置 sources 的 endpoint、类型、是否需要认证和缓存期限；不要把本轮研究用的搜索工具当成砚已拥有的 API。每轮默认最多两次查询改写、每源最多两页、候选最多八项，只有新信息才扩大范围，遵守源限流并支持取消。

## 12. 候选、接入计划与评估

新增类型（设计契约，字段可按既有风格落地）：

~~~ts
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
~~~

候选目录与 Capability 的可用目录分开；只有激活与验证完成才成为 ready。候选排名考虑目标匹配、能否在 Windows/当前运行时执行、认证是否已有、维护与许可信息、所需权限及接入代价；下载量不是可信证明。
模型解释选中理由，主进程负责结构校验、来源一致性和执行策略，不让模型直接决定安装 shell 字符串。源内容变化导致 digest/revision 改变时，旧计划失效。
固定 npm 精确版本、Git commit 或其它不可变 artifact；检查同名仿冒、原仓库和包元数据关系、协议/依赖兼容。不因为搜索结果第一名就自动执行。
安装器返回实际文件与依赖清单、日志摘要和失败阶段；metadata-only 不得显示“已经验证”。来源无法核实时可给候选说明，不能捏造 verified。

## 13. 自动接入策略与认证

产品默认策略建议为“自动搜索 + 在已授权来源和权限范围内自动接入”。用户在能力设置中可切换“仅已有 / 搜索并推荐 / 自动接入”；当前需求的验收使用自动接入档，而不是把推荐列表当最终交付。

- 已启用的发布者/来源范围、可使用的本地运行时、项目级读写权限及外发范围组成持久策略；不是每次都弹一次许可。
- 纯 Skill 文件可先下载到 staging 做内容核查；任何脚本执行或额外依赖安装都纳入接入计划。Skill Markdown 能引导后续工具行为，不能把“只是文本”当自动安全结论。
- 对满足策略、固定版本且依赖齐备的候选自动接入、测试和继续，不要求用户复制命令。
- 新来源超出策略、系统级依赖/提权、缺账号或额外费用时，只请求这一项缺失条件；展示具体能力、来源、范围和原因。不要泛化为每个工具都需确认，也不把网络目录的描述当用户授权。
- 已有认证仅在同一授权服务/账号范围内复用；不把其他服务 token 复制给新 endpoint。凭证进入安全存储，不进入 prompt 或 Skill 文件。
- 远程 MCP 无需本地安装时直接走“验证端点 → 登记配置 → 连接 → 枚举工具”；不能为了统一界面伪造下载步骤。
- 手动 token/header 为基础路径；OAuth 型服务若没实现授权回调，准确保持 needs-auth。该限制不妨碍无认证/已认证服务自动闭环，也不能因此声称支持所有服务。

工作模式不改变授权范围。澄清模式可联网检索元数据，但不执行安装或写操作；需求就绪后转标准再接入。自主模式自动尝试策略允许的替代候选；缺失条件无法自行补齐时保留进度并报告。

## 14. 下载、安装、生效与继续任务

### 14.1 接入事务

状态机：discovered → inspected → prepared → acquiring → verifying → activated → resumed；另有 needs-auth / needs-authorization / pending-boundary / failed / cancelled。
主进程持久化 operationId、planRevision、runner/generation、goal/sourceHead、已下载文件和恢复点；acquire 重试使用同一个 operationId，不能多次安装同一候选。

1. 在 YAN_DIR 的受管 staging 目录下载，不往项目根或用户真实技能目录散落文件。
2. 校验 archive 路径、大小、文件数量、符号链接、hash 与来源；拒绝路径穿越和解压膨胀。
3. 首版自动接入覆盖 Skill 文件、已验证的 pi npm/git 包、本地已有 Node 环境可运行的 MCP 包和远程 HTTP MCP。Python/uv、容器等如环境已有且接入器验证通过可扩展；未实现时明确 unsupported，不静默安装全局运行时。
4. 依赖和生命周期脚本按策略执行，先检查后执行；禁用脚本时若影响功能应如实失败，不能把安装退出码 0 当可用。包和服务器会执行本机代码，不宣称 staging 是安全沙箱。
5. 隔离测试注册/读取/握手及无副作用 smoke；遇无只读工具的 MCP 仅验协议可达，业务调用待授权任务执行，不能随意调用写工具“测试”。
6. 原子登记能力及 receipt，激活成功后继续原 goal；失败只清理本次受管 staging/依赖，不碰用户已有安装。

### 14.2 与 pi 包管理和运行中任务的冲突

现有 packages.ts 在目标目录有任务运行时拒绝装卸，且扩展在启动时加载。**不得删除这道检查来实现自主安装。** 按不同资源处理：

- 普通 Skill 文件：砚受管目录按项目隔离，由 skill-service 按固定版本读取；不要求动态注入任意 pi 扩展。刷新能力目录即可。保留 pi 格式与资源规则，不重复列出同一个 Skill。
- MCP 独立进程/远程连接：由砚宿主启动/连接，通过已随包加载的固定代理工具调用；不需要每发现一个 MCP 就给 pi 安装一个新扩展。
- 确实需要 pi 包/扩展的候选：保存接入计划，返回 pending-boundary，当前轮安全结束后由调度器进入安装/重载；不能在 acquire 工具内部等“当前回合结束”，否则互相等待死锁。
- 修改范围涉及共享包目录时，检查所有受影响 runner；不得中断无关任务或更新它正在使用的依赖。优先项目受管目录固定版本并存；无法安全隔离则等待明确空闲状态或选择替代候选。
- 使用同一 resolvePi 与 PI_AGENT_DIR，不出现装到 A、运行 B。安装后的资源重载/重建必须验证 session、队列、模式、模型和文件引用不丢。

纯 Skill 与宿主 MCP 必须至少各有一条无需用户手动新建会话的闭环。pi 包若需要重启，保存 sourceHead 和 continueId，以既有会话重建 + 一次性内部继续完成；运行时无法安全支持时，不能把“下次启动可用”算成自动继续已验收。

### 14.3 恢复与停止

用户停止即取消未执行步骤和自动续行；已安装资源可保留为未启用，不自动执行。后续用户继续时复查原目标及计划是否仍有效。
失败不自动改为“更新所有包”；写操作断线不重复执行。自动尝试最多两个不同候选、每个接入事务一次正常重试；无新证据则说明失败与替代路径。
崩溃恢复校验 receipt、文件 hash、实际连接和继续消费证据；不以“事务记录写过 activated”替代真资源检查。continueId 已消费则不再次发同一个任务。

## 15. 用户可见状态与资源生命周期

目标执行时间线显示“正在找合适能力 → 找到候选及选择原因 → 接入中 → 测试中 → 已用于任务”；缺认证和不支持平台给具体条件。不要只弹“插件安装成功”就结束当前目标。
能力页展示来源链接、固定版本、安装范围、真实可用性、最近验证、谁/哪个任务引入及磁盘占用；用户可禁用/移除，正在使用时在安全边界处理。
默认项目受管安装，重复任务复用相同版本；不每次重新联网安装。更新走单独事务，保留在用版本；停止/失败不删除用户文件，卸载仅删除砚登记拥有的资源。
搜索缓存有时间与来源标记；离线时可用已验证的本地能力，不能把缓存候选标为当前已联网验证。搜索源不可用、限流和解析失败分别显示，用户不必重述原目标。

## 16. 新增必做验收与交付边界

在原 §9 基础上增加：

| 场景 | 通过标准 |
|---|---|
| 干净环境缺 Skill | 模型按目标联网找到初始目录中不存在的 Skill → 读取固定来源 → 接入 → 真执行并验证产物；用户未提供包名 |
| 干净环境缺 MCP | 模型找到未配置服务 → 生成计划 → 启动本地服务器或登记真实远程端点 → tools/list/call → 完成原目标 |
| 无通用搜索密钥 | Skill/MCP 的至少一条目录检索路径仍可用，无“先装搜索插件才能搜索”的循环依赖 |
| 安装需要安全边界 | 当前工具不死锁，队列/会话不丢、其他 runner 不被重启、continueId 仅消费一次 |
| 缺认证/不支持平台 | 不报 ready，不造结果；说明确切缺口，自动尝试可用替代能力 |
| 来源变化与恶意内容 | plan hash 变化失效；README 注入不改变授权；压缩包越界被拒；unknown 工具不绕过模式门禁 |
| 失败、停止、重启 | 不留下半登记的 ready 项，不重复安装/外部写/续行；原目标和历史可恢复 |
| 缓存和卸载 | 复用正确版本，禁用后下一请求不可调用；只清除受管资源 |

协议故障/下载故障采用 fixture；**联网发现成功**必须至少有真实目录检索证据，**模型自主选择**必须有真实模型证据。外部目录的内容会变化，fixture 不断言永久固定的排名/包名；真实联网记录实际返回的来源、版本、时间与最终选择。
从准备时确认“未安装/未配置”的状态开始，收集搜索结果、安装 receipt、实际调用、产物与原目标验收，六个阶段不能互相替代。不得预装目标能力后宣称验过“自行发现并安装”。
交付六栏：实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制。C 完成必须覆盖“现有能力自动选用”和“缺失能力联网补齐”两条主链；只展示搜索结果、安装按钮或已安装目录不算完成。
