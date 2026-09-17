# 砚本机控制桥

## 目的

当前 Codex Computer Use 会话只暴露浏览器控制，不能直接绑定砚的原生 Electron 窗口。本机控制桥提供一个主动启动的浏览器页面，让浏览器连接器或 MCP/CUA 通过 `127.0.0.1` 控制正在运行的砚实例。

它不使用 Electron 的 `remote-debugging-port`。每个请求短暂启动第二个 Electron 进程，由已有的单实例 `second-instance` 通道把命令交给主实例，再通过临时响应文件回传结果。

## 使用

先让砚运行在已经包含控制桥的构建上，然后在项目根目录执行：

```powershell
npm run control
```

脚本会打印带随机令牌的本机地址，例如：

```text
http://127.0.0.1:37891/?token=...
```

把这个地址交给浏览器连接器即可。控制页提供：

- 读取窗口和 Agent 状态；
- 显示并聚焦砚窗口；
- 发送受限导航键；
- 在当前焦点插入文本；
- 按内容区域坐标执行单次左键点击；
- 在页面确认后向当前砚会话发送消息。

`send` 可能触发模型调用和额度消耗，只有用户明确要求时才使用。控制桥只监听 `127.0.0.1`，令牌只在当前启动期间有效；它不接受任意 Node/Electron 代码，也不提供系统命令执行接口。

## 当前限制

- 已经运行的旧 Electron 实例不会热加载主进程代码；改完 `src/main/**` 后必须由用户正常关闭并用 `启动-砚.cmd` 重新启动一次。为保护正在运行的任务，自动验证不会强制终止用户实例。
- 控制桥是浏览器可见的本机页面，不等于原生 Windows Computer Use。原生连接器恢复后，仍应优先使用原生窗口句柄和新鲜的窗口状态。
- 控制页和临时响应文件是开发期控制面，正式发布前应重新审查端口、令牌生命周期和用户确认策略。

## 实现与证据

- 协议与主进程动作：`src/main/control-protocol.ts`、`src/main/index.ts`；
- 控制页与第二实例调用器：`scripts/yan-control.mjs`；
- 启动入口：`package.json` 的 `control`；
- 2026-09-18 隔离实例实测：浏览器/MCP 控制页的 `status`、`focus`、`key(Escape)` 均返回 `ok: true`；`focus` 返回 `visible: true`、`focused: true`。测试使用独立 `YAN_USER_DATA`、`YAN_SESSIONS_DIR`、`YAN_DATA_DIR`、`YAN_PI_DIR`，没有触碰真实砚进程。
