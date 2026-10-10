# 独立运行与文件任务

> 2026-10-08 方向更新：本文记录当前工作区的既有实现与使用方式，不代表发布版本或新产品主线。独立任务面板、任务级授权/预算和成果管理列入[精简复核](PRODUCT_DIRECTION.md)，暂停按旧通用执行平台方案继续扩建；尚未删除代码或数据。

[文档索引](README.md) · [代码导览](PROJECT.md) · [多 Agent 工作台](AGENT_HUB.md)

运行服务保留官方 pi 的模型循环、原生会话 JSONL 和上下文管理。桌面与本机 Node 宿主使用同一组文件任务、权限、预算、审批与恢复实现；现有编码会话、Git/worktree、子 pi 和外部 CLI Hub 继续保留各自事实源。

## 文件任务服务

桌面「任务」页面已退役，工具菜单不再提供入口；本页只覆盖独立运行服务与显式服务命令（见下文「本机 Node 入口」）。普通文件任务不要求 Git。输入复制进独立工作目录，输出写入 `outputs/`，原件不交给 Agent 直接修改。

选用当前会话模型时，宿主为独立服务复用当前模型的配置与凭证快照，密钥不返回界面、不改写原始认证/模型配置。受预算约束的转发适配支持 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages API；其他协议或需要专用 OAuth 刷新的模型会解释原因并拒绝，原有会话仍可使用它们。未配置模型、运行时或授权扩展缺失时不能执行。

关闭整个应用仍按现有退出流程停止执行，没有新增系统常驻服务。停止只影响所选任务。

成果规则沿用原桌面流程的约定（界面入口已退役）：可文本预览、定位文件夹及另存/应用。应用前选择目标、查看清单并明确批准。覆盖输入原件核对导入时的 SHA-256；目标或成果变化时拒绝覆盖。多文件应用逐文件报告已应用、冲突、待处理和错误，不承诺跨文件原子事务；外部程序不遵守本服务的锁，乐观版本检查不能消除所有竞态。一次批准只对应一次应用尝试。

## 本机 Node 入口

入口只编译到临时目录，不启动 Electron、不覆盖桌面 out：

```powershell
npm run agent:service -- C:\path\service-config.json
```

配置显式指定独立数据根、Node、官方 pi JS 入口和授权扩展。以下使用本机测试模型，需替换路径与端口：

```json
{
  "dataRoot": "C:\\AgentSandbox\\data",
  "runtime": { "executable": "C:\\Program Files\\nodejs\\node.exe", "cli": "C:\\path\\pi\\dist\\bundle\\cli.js", "kind": "node" },
  "guardExtension": "C:\\path\\Inkstone\\resources\\pi-extensions\\service-authority.js",
  "modelConfig": {
    "provider": "fixture", "baseUrl": "http://127.0.0.1:9000/v1", "api": "openai-completions", "apiKey": "fixture-only",
    "model": { "id": "fixture", "contextWindow": 32000, "maxTokens": 1024 }
  }
}
```

省略 modelConfig 可创建、预览与交付文件，但不能执行模型。服务不自动读取个人凭证、不安装常驻服务、不公开监听。控制通道是 stdin/stdout JSONL；预算与工具授权使用带随机运行令牌的临时 loopback 通道。保护配置文件与显式数据根，其中会保存私有运行配置。

每行一条命令，响应带相同 id。写操作必须使用 8–128 字符幂等键，同一键只能重试相同操作和参数：

```jsonl
{"id":"create-request-001","action":"create","payload":{"title":"整理文档","files":["C:\\Input\\notes.txt"],"budget":{"maxTimeMs":600000,"maxModelCalls":40,"maxToolCalls":100}}}
{"id":"snapshot","action":"snapshot"}
{"id":"run-request-001","action":"run","taskId":"returned-task-id","payload":{"prompt":"整理 inputs/notes.txt，把结果写进 outputs/summary.md"}}
{"id":"output-list","action":"outputs","taskId":"returned-task-id"}
{"id":"preview","action":"preview","taskId":"returned-task-id","payload":{"name":"summary.md"}}
{"id":"cancel-request-001","action":"cancel","taskId":"returned-task-id"}
```

应用分三步：plan-apply 的 payload 为 `{"items":[{"output":"summary.md","destination":"C:\\Output\\summary.md"}]}`；approve 传 approvalId/generation/approved；apply 传 approvalId。还支持 history（原生会话位置/文件清单）、reconcile（明确核实不明运行已结束）、authorize-children（宿主授权派活）与 close。不暴露任意 RPC/shell。

服务拒绝包含 desktop.json 的桌面数据根；每个规范化数据根只有一个合作写入者。已知死进程锁在受协调的锁守卫下回收；缺少 owner 或锁交接中断时拒绝启动，须先核实 `.runtime-writer` / `.runtime-writer-guard`。不得与未接入锁的旧版应用共享用户数据。

## 权限、预算与恢复

- 只开放 read/write/edit，输入副本只读，输出根可写。路径/链接越界及 Windows 歧义路径在调用前拒绝。shell、浏览器、电脑操作、外部 CLI 和任意网络工具未配置，不暴露为可调用工具。这是受信执行器约束，不是操作系统沙箱；运行时篡改、外部进程和恶意文件系统竞态不在隔离保证内。
- 模型只能经宿主转发到显式服务源，不跟随重定向；请求数在转发前扣减，工具数在执行前扣减。时间预算停止活跃运行，父子累计消耗，子任务权限和预算不能扩大，预算耗尽后停止新增派活。不提供费用预授权，不承诺服务商账单零超支，不把订阅额度当作 API 价格。
- 原有桌面两档权限与高危确认保持不变。独立任务不增加普通工具“每次询问”模式；执行器确认和成果批准绑定任务与 generation。缺少审批客户端时保留等待，时间预算仍生效；未适配的结构化输入请求取消并报错。
- 运行、审批、请求摘要及工具回执持久保存。执行前写回执，完成后写结果；存储失败后拒绝后续写操作。重启把仍在运行或缺完成回执的请求标为结果待核实，不自动重试副作用。reconcile 只确认旧执行结束，不表示验收，也不清除旧回执。

## 能力协商与兼容

能力区分 implemented/configured/available/authorized。远程 `/remote/v1/info` 保留兼容字符串列表并增加 capabilityDetails，字符串列表只包含当前身份可调用的操作。peer 和 agent 不再收到普通手机操作的可用声明，服务端门禁仍是执行授权依据。

Android 每次事件连接重新打开时重取能力和授权，发送、图片、停止控件按协商结果启用；旧服务器缺详情字段时回退字符串列表。不改变协议版本、配对或既有 ID，不为手机另建执行事实源。范围为 Windows 桌面、本机 Node 和 Android 远程参与，没有新增其他平台发行链。

## 检查

```powershell
node scripts/test-agent-service.mjs
node scripts/test-agent-service.mjs --pi
node scripts/test-agent-service-cli.mjs
node scripts/test-capability-negotiation.mjs
npm run build
```

`--pi` 使用真实 Node、官方 pi 与本机模型夹具，检查工具、预算、取消、时间、父子累计和原生会话保存。独立文件任务桌面页面及其 UI 探针已退役；本页保留显式服务命令与契约，不表示普通会话需要经过此服务。文件策略和能力专项纳入 unit；真实账号、真机、安装包和发行验收须单独取得证据。
