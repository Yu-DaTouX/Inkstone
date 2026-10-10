# Hermes 控制砚插件

让 Hermes 通过工具查看和操作正在运行的砚桌面客户端。插件只有 Python 标准库依赖，不修改 Hermes 核心，也不需要在砚中增加常驻插件运行时。

## 功能

| Hermes 工具 | 操作 |
| --- | --- |
| `inkstone_read` | `info` 接口能力、`status` 运行状态、`sessions` 会话列表、`history` 消息与结果、`models` 指定会话的可用模型、`questions` 待答与待审批问题 |
| `inkstone_control` | `new` 新建会话、`select` 切换桌面会话、`send` 发任务、`model` 选择模型、`rename` 改名、`abort` 停止指定运行、`answer` 回答普通问题 |
| 用户命令 `/inkstone` | 展示具体审批操作，由用户明确允许或拒绝；不作为模型工具注册 |

发送与停止均要求明确的目标 ID，不依赖砚当前焦点。新建会话使用电脑当前工作目录并切换桌面视图；当前插件不支持传入任意目录。人工批准通过用户命令提交，模型不能通过控制工具自行批准。插件不提供鼠标点击、任意文件访问、终端注入或浏览器控制。

## 安装

需要支持 `plugin.yaml`、`register(ctx)` 和 `ctx.register_tool()` 的 Hermes，以及包含远程接入接口的砚桌面版本。参考 [Hermes 官方插件说明](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/)。

0.2.0 的人工批准还需要 Hermes 的 `ctx.register_command()` 和新版砚的 `human-approval` 能力。旧砚不支持新路由，**仅替换插件无法开启批准**；更新电脑端并正常重新启动后生效。

将本文件所在的目录完整复制或解压为：

```text
~/.hermes/plugins/inkstone/
  plugin.yaml
  __init__.py
  client.py
  approvals.py
  connect.py
  README.md
```

使用独立 Hermes profile 时，放到该 profile 的 `HERMES_HOME/plugins/inkstone/`，连接文件也随同该 profile 隔离。Windows 使用 `%USERPROFILE%\.hermes\plugins\inkstone\`，或已配置的 `HERMES_HOME`。

新版 Hermes 第三方插件需要显式启用：

```sh
hermes plugins enable inkstone
```

在 Hermes **下一次正常启动**后使用；正在运行的旧会话不保证热加载。旧版本若没有插件命令，请先核对是否具备上述 Python 插件接口，不能仅按版本号假设支持。

## 连接电脑

在砚的 **设置 → 设备连接 → 手机接入** 开启远程访问并生成配对码。Hermes 与砚在同一台电脑上时可用 `http://127.0.0.1:37892`；Hermes 在手机、另一台电脑或容器里时，使用 Hermes 能访问到的电脑地址。手机上的 `127.0.0.1` 是手机自身。

在 **运行 Hermes 的环境**中，使用 Hermes 的 Python 执行：

```sh
python ~/.hermes/plugins/inkstone/connect.py --url http://127.0.0.1:37892 --name Hermes
```

根据提示输入电脑显示的六位配对码。使用自定义 `HERMES_HOME` 或 Windows 时，将脚本路径换成安装的实际路径。插件名与文件名保持不变。

配对成功后令牌保存在当前 `HERMES_HOME/inkstone-connection.json`，默认是 `~/.hermes/inkstone-connection.json`，不会打印到终端。文件含明文设备令牌，应由 Hermes 运行账户独占读取；Unix 创建为 `0600`，Windows 依赖所属目录的账户 ACL，此文件没有额外密钥库加密。不要把它放进代码仓库或发给模型。

验证连接，不触发模型：

```sh
python ~/.hermes/plugins/inkstone/connect.py --check
```

也可以由运行环境提供 `INKSTONE_URL` 和 `INKSTONE_TOKEN`，不保存连接文件；两者优先于连接文件。`INKSTONE_CONNECTION_FILE` 可指定连接文件路径。插件的工具参数不接受服务地址和令牌。

这是使用既有 `phone` 协议权限的普通远程客户端，电脑设备列表显示名称 **Hermes**；不新增权限挡位。请为插件单独配对，撤销此设备即可取消访问。人工批准只接受单独配对的用户客户端，不接受旧单令牌、礁石 `agent` 或其他砚的 `peer` 身份。

批准命令依赖 Hermes 本身验证消息发送者和允许访问该 profile 的用户。请只在自己的 Hermes CLI 或已限制到可信用户的聊天渠道启用；插件不是同一系统账户内恶意代码的隔离层，持有设备令牌的客户端属于可信授权边界。

HTTP 仅用于回环地址或可信私有网络（例如你已有的 Tailscale 链路）；公网访问需要安全隧道或 HTTPS。插件不自动开放电脑端口、不自动启用中继、不修改防火墙。

## 使用例子

对 Hermes 说：

> 查看砚的会话，找出刚才的项目会话，读取最新回复。

> 在砚里新开一个会话，查看可用模型，选择我指定的模型，提交这个任务，然后回来读取结果。

> 停止砚里这个会话正在运行的任务，其他任务继续。

典型工具调用：

```json
{"action":"sessions"}
```

从列表拿到 `session_id` 后读取消息：

```json
{"action":"history","session_id":"返回的会话 ID","limit":20}
```

查看模型后，通过 `inkstone_control` 选择**接口实际返回**的 provider/model ID，再发任务：

```json
{"action":"model","session_id":"返回的会话 ID","provider":"接口返回的 provider","model_id":"接口返回的模型 ID"}
```

```json
{"action":"send","session_id":"返回的会话 ID","text":"用户交代的任务"}
```

停止使用 `status` 或发送结果里的 `runId`，例如：

```json
{"action":"abort","run_id":"r1"}
```

`send` 成功表示电脑接受任务，**不表示任务已完成**。通过该会话的 `history` 读取回复，通过 `status` 观察对应运行。历史默认 40 条，上限 100 条；继续向前读取时将返回的 `nextBefore` 传给 `before`。

`send` 会产生实际模型调用和电脑上的工具执行，使用砚已有的「危险审批 / 全部允许」状态。插件不自动确认危险操作，不改变模型凭证或权限设置。

## 在 Hermes 中批准或拒绝

你可以在 Hermes 的 CLI 或已授权聊天渠道直接输入：

```text
/inkstone approvals
```

插件展示完整操作、风险说明、会话与运行，以及此操作的短期确认码。例如：

```text
/inkstone approve 7b4e81c2
/inkstone deny 7b4e81c2
```

**只输入你要作出的一个决定。** 确认码两分钟内有效，原审批可能更早到期。批准只允许这一次，不记住目录、不切到全部允许。电脑和 Hermes 哪一端先处理，另一端就不能再次放行；操作内容或目标变化时必须重新展示。连接中断时按提示重试同一个命令，复用请求编号。

此功能接入砚真实的批准卡片，包括主会话、子 Agent 的危险操作；敏感 UI 确认也使用同一人工回传通道。普通 `answer` 仍不能批准敏感请求。

模型可用 `questions` 查看待答状态、提醒你运行以上用户命令；普通文本/选择问题则使用 `answer`，传入 `question_id` 及 `value`、`confirmed` 或 `cancelled`。用户命令没有注册成模型工具，不能把模型写出的“用户已同意”当作许可。

本版没有后台事件监听或自动唤醒 Hermes；任务等待时需由当前 Hermes 会话查询 `questions`，或你直接执行用户命令查看。操作系统 UAC、浏览器登录和提供商账号授权不在此审批接口范围内。

提交返回 `requestId`。网络超时时结果可能未知；先读取状态与历史确认。对 `new/send/model/abort`，若确需重试，在 **10 分钟内**复用同一 `request_id` 和相同操作及参数；更换编号可能导致重复任务。插件不自动重试写请求。`select/rename` 仍沿用现有接口语义。

## 排查

- 没有工具：核对安装目录、`hermes plugins enable inkstone`、当前 Hermes profile 与工具集开关，然后正常重开 Hermes。
- 连接失败：确认电脑端砚运行、远程接入开启，地址从 Hermes 所在环境确实可达。
- 401：设备已撤销或令牌不对，重新配对。
- `agent_scope`：使用了 Hub 专用令牌，请为此插件独立配对。
- 409：目标任务忙、会话已变化或操作不能执行，以电脑端返回原因处理，不切换到其他会话重试。
- 模型名称找不到：读取目标会话的 `models`；插件不猜测模型 ID，也不替你配置订阅或凭证。

## 开发验证

在砚源码根目录执行 `node scripts/test-hermes-plugin.mjs`。默认调用 `python`；`YAN_TEST_PYTHON` 可指定 Python 可执行文件。检查使用真实 RemoteServer 路由与 Python 插件处理器，但业务 handler 为隔离夹具，无模型请求；不能代替实际 Hermes 安装、真实模型或其他系统运行验收。

构建后可执行 `node scripts/test-hermes-plugin-desktop.mjs`：使用独立数据目录、实际 Electron/pi 与可丢弃的构建入口副本，注入只请求确认的扩展，验证允许/拒绝恢复原请求。该测试不执行危险命令，也不调用模型；完整 Hermes CLI/聊天渠道仍需在安装后验收。

针对已有 `/data/local/hermes/run-hermes.sh` Ubuntu chroot 部署的 adb 手机，可执行 `node scripts/test-hermes-plugin-desktop.mjs --adb`；多设备时通过 `YAN_ADB_SERIAL` 选择。它在手机独立临时 profile 中使用已安装 Hermes 的官方 manifest 加载器和工具注册表，经临时 USB reverse 连接 Windows 隔离实例，验证普通问题、人工允许/拒绝与无害 pi 命令投递。测试退出会删除测试连接凭据并撤销自己建立的 reverse，不改生产 profile、不启停聊天网关。使用预置的隔离设备令牌，不代替用户配对操作、Hermes 模型自主调用或 Telegram/QQ 渠道验收；其他手机部署路径不适用。
