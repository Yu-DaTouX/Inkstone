# 砚 · 安卓远程管理端

## 目标

Android 端是电脑端 Yan 的远程访问和管理客户端。pi、桌面工具、会话文件和凭证继续留在电脑上；Android 不直接读取电脑文件，也不运行 Electron 或 pi。

```text
Android
  │ HTTP + SSE（第一阶段）
  ▼
Electron 主进程 Remote API
  │
  ├─ RunnerRegistry / AgentController
  ├─ pi RPC
  └─ 会话 JSONL
```

远程 API 放在主进程，不放在 renderer，也不使用 Electron `remote-debugging-port`。本地桌面端和 Android 端都通过主进程看到同一份会话与运行状态。

## 当前第一阶段

远程服务默认关闭。显式设置 `YAN_REMOTE_ENABLE=1` 或 `YAN_REMOTE_PORT` 后才监听端口。

当前提供：

- `GET /remote/v1/health`：健康检查，不需要 token；
- `GET /remote/v1/info`：协议版本、传输方式和能力列表；
- `GET /remote/v1/status`：桌面窗口、pi 连接、当前会话和运行实例快照；
- `GET /remote/v1/sessions`：会话摘要列表，不返回绝对文件路径；
- `GET /remote/v1/sessions/:id?limit=200`：读取指定会话历史；
- `GET /remote/v1/events`：SSE 实时推送消息、工具、状态、运行实例和连接事件；
- `POST /remote/v1/sessions/new`：新建会话；
- `POST /remote/v1/sessions/:id/select`：切换电脑端当前查看的会话；
- `POST /remote/v1/sessions/:id/messages`：向指定会话发送消息；
- `POST /remote/v1/sessions/:id/rename`：重命名会话；
- `POST /remote/v1/runs/abort`：停止当前任务。

除健康检查外，请求需要：

```http
Authorization: Bearer <YAN_REMOTE_TOKEN>
```

## 开发启动

PowerShell 中开启一个只绑定本机的远程服务：

```powershell
$env:YAN_REMOTE_ENABLE = '1'
$env:YAN_REMOTE_HOST = '127.0.0.1'
$env:YAN_REMOTE_PORT = '37892'
$env:YAN_REMOTE_TOKEN = 'dev-token-change-this-123456'
npm run launch:dev
```

主进程启动后会在控制台输出监听地址和 token。Android 模拟器或真机需要访问电脑时，把 `YAN_REMOTE_HOST` 改为 `0.0.0.0`，并使用电脑在局域网中的 IP；同时需要 Windows 防火墙允许该端口。正式产品不应把端口直接暴露到公网，优先使用私有网络或中继服务。

也可以使用 `YAN_REMOTE_PORT=0` 让系统分配临时端口，适合自动化验证；实际端口会在启动日志中打印。

## 安全边界

- 远程服务不默认启动；
- token 只在当前进程内存中有效，未写入用户数据目录；
- 会话历史只能按稳定 `sessionId` 查找，网络请求不能传任意文件路径；
- API 不提供任意 shell、任意文件读取、任意 Electron API 或调试端口；
- 会话列表和状态不返回会话文件绝对路径，只返回目录名等展示字段；
- Android 的写入操作必须经过认证，并使用显式的操作路由；
- 当前 token 是开发期授权方式，正式版仍需要二维码配对、设备密钥、撤销设备和权限分级；
- 当前 SSE 只转发远程管理需要的事件，不转发内置浏览器状态和桌面 UI 模态事件。

## 实现位置

- 协议服务：[src/main/remote-server.ts](../../src/main/remote-server.ts)
- Electron 主进程接入：[src/main/index.ts](../../src/main/index.ts)
- 协议单测：[scripts/test-remote.mjs](../../scripts/test-remote.mjs)
- 单元测试入口：[scripts/test-unit.mjs](../../scripts/test-unit.mjs)

## 当前限制

- 目前只有 HTTP + SSE，还没有 WebSocket；
- token 仍通过环境变量或启动日志提供，没有二维码配对 UI；
- 只支持操作当前桌面端的会话运行实例，不支持 Android 端直接执行桌面 shell；
- 外网连接、中继、TLS、设备密钥和 Android APK 尚未实现；
- 真正的 Android 客户端 UI 尚未加入仓库；本阶段先把电脑端远程 API 和协议边界做实。
