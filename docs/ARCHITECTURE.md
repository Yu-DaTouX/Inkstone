# Inkstone 架构简介

产品目标见[产品方向](PRODUCT_DIRECTION.md)：以 pi 会话与指定模型子 Agent 为核心，桌面目标为 Windows/macOS/Linux，Android/iOS 远程连接电脑。下文为当前源码结构，未完成的平台和精简项不视为已交付。

Inkstone 使用 Electron、React 和 TypeScript，通过独立 pi 子进程完成模型循环与工具执行。

独立运行与普通文件任务属于待精简复核的既有实现，不作为未来所有会话必须经过的架构。普通文件任务另由 `src/core/agent-service.ts` 保存任务、审批、预算与成果事实，桌面 IPC 和 `src/adapters/service-cli.ts` 复用同一服务。独立 Node 入口显式选择运行时、模型和数据目录；官方 pi 仍拥有消息、历史与压缩。现有桌面会话、多 Agent 工作台和外部 CLI 保留原后端，Android 通过已有协议协商能力。详见[运行服务](AGENT_SERVICE.md)。

```mermaid
flowchart LR
  UI[React 界面] --> Bridge[preload 白名单接口]
  Bridge --> Host[Electron 主进程]
  Host -->|JSONL RPC| Pi[pi 子进程]
  Pi --> Provider[模型服务]
  Pi --> Tools[工具执行]
  Host --> Workspace[文件 / 终端 / 浏览器]
  Pi -->|事件| Host
  Host -->|MainPush| UI
```

## 职责

- **渲染进程**：会话与项目界面、输入、内容展示和用户操作；通过 preload 使用宿主能力。
- **preload 与共享契约**：限制可调用入口，维护跨进程类型和事件结构。
- **主进程**：会话生命周期、pi RPC、文件和终端、浏览器表面及配置持久化。
- **pi**：模型循环、上下文与工具执行；随包适配位于 `resources/`。

上下文管理归 Agent：pi 的原生压缩、恢复、技能与项目规则由 pi 执行，其他 CLI Agent 使用自己的机制。砚展示用量、压缩状态和工具结果，用户点选的压缩操作直接走 pi RPC；不生成宿主摘要，不按工作集预算改写请求，不自动交接或续跑。资料由用户主动发送，或由 Agent 自己读取。

pi 0.99 及以上的 MCP、codemode 与工具搜索使用原生内置扩展。宿主的共享浏览器、电脑操作与授权协调继续经过砚的能力入口；旧宿主 MCP 配置保留兼容，新配置优先使用 pi 的 `mcp.json`，不把受管设备服务自动迁移到另一套权限边界。

## 数据与运行边界

本地设置和会话由应用与 pi 持久化；连接远程模型时，请求发送至所选服务。数据位置见 [发布与备份](dev/RELEASING.md#数据位置与备份)。应用的本地档案不等于模型账号登录。

Electron 网页表面与 React DOM 分属不同层，浏览器浮层、窗口缩放和焦点切换需要在宿主与界面间协调。切换会话时应明确各事件所属的会话，避免后台事件覆盖当前会话状态。

消息内的 HTML 成果不复用带宿主桥接的主页面：主进程只为受控成果目录内不超过 5 MiB 的完整文件建立随机令牌快照，经 `inkstone-html:` 独立协议交给无同源权限的 sandbox iframe。独立响应头 CSP 允许内联脚本与样式，但禁止联网、其他文件、子网页和表单；主窗口不放宽 `script-src`，IPC 同时校验主窗口及其 main frame。预览卸载即释放，主窗口重载、崩溃或销毁清空快照；并发读取与活跃预览合计最多 16 个。普通 Markdown 与代码块不作为网页执行。

具体文件入口见 [代码导览](PROJECT.md) 和 [按功能查找的代码地图](CODE_MAP.md)。语言、桌面壳与手机客户端的取舍见 [技术路线评估](TECH_STACK_OPTIONS.md)。接口以源码为准，本页不记录内部排期或阶段验收结论。
