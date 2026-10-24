---
name: inkstone-fabric-dev
description: 开发 Minecraft Fabric mod（新建项目、加物品方块、画贴图、写 Mixin、改配方、修崩溃）并在开发客户端里验证时使用。配合 inkstone-minecraft MCP 的 mc_* 工具：改完代码用 mc_apply 热替换或重载，用 mc_view 截图/渲染确认，用 mc_logs 查崩溃。用户只说「做个红宝石 mod」「这个方块贴图不对」「游戏崩了」也算。
---

# Fabric mod 开发循环

目标是让用户看到改动在游戏里生效，而不是只让代码能编译。每一轮都按「改 → 同步 → 看」走完，并把截图或渲染图给用户看。

## 工具

| 工具 | 什么时候用 |
| --- | --- |
| `mc_new_project` | 新建项目。版本号来自 Fabric 官方元数据，不要手填 |
| `mc_run` | `start` 启动开发客户端并进入测试世界（默认和平难度、创造模式、en_us），可同时给 `gamemode`/`difficulty`/`lang`/`time`/`weather` 把环境一次调好；`status` 看状态、控制方、当前环境（世界/版本/模式/难度/语言/坐标）与性能；`stop`、`restart`；`take_control` 从用户手里收回控制权（仅在用户明确同意后） |
| `mc_apply` | 每次改完代码或资源都调用：增量编译 → 热替换类 → 重载资源/数据，返回哪些生效、哪些需要重启。`restart_if_needed=true` 时自动重启 |
| `mc_build` | 只想看编译错误时用 |
| `mc_view` | `screen` 截图；`count`/`intervalMs` 连拍（每张带时间戳）、`hideHud` 隐藏 HUD、`crop` 只截一块、`grid` 在图上叠坐标网格与刻度（看图点自定义界面先开它）；`item`/`block` 渲染单个物品或方块的透明 PNG |
| `mc_input` | 真实输入：`attack`/`use`（可先对准方块或实体）、`look`、`move`、`hotbar`、`key` |
| `mc_ui` | 读界面并操作：`read` 界面类名、槽位与控件；`click`、`type`、`key`、`open`、`close` |
| `mc_chat` | 读聊天、系统消息、actionbar、标题；`since` 做增量 |
| `mc_script` | 一串步骤（`command`/`input`/`ui`/`wait`/`screenshot`/`player`/`chat`/`perf`/`tick`）在客户端 tick 上按顺序跑，一次拿回每步结果与截图；`screenshot` 步也支持 `grid`，`tick` 步参数同 `mc_tick` |
| `mc_perf` | FPS、MSPT、TPS、内存、实体数、区块数 |
| `mc_highlight` | 高亮测试对象：`entity`（`selector` 或 `uuid`）圈实体、`block`（`pos`）描方块、`clear` 清掉；`color` 用 `#rrggbb`、`seconds` 默认 30 |
| `mc_wait` | 等一件事发生（`in_world`、`screen`、`no_screen`、`chat`、`ticks`、`entity`、`player`），等到就返回结论，超时第一行是「等待超时」，用来代替反复截图轮询 |
| `mc_tick` | 放慢、冻结、单步推进游戏逻辑：`status`、`rate`（1–10000）、`freeze`、`unfreeze`、`step`、`sprint`、`reset`（解除冻结并调回 20）。只影响游戏逻辑 tick，不影响渲染帧率与按真实时间计的界面动画；测完必须 `reset` |
| `mc_command` | 以权限 4 执行命令：`give @s mymod:ruby`、`setblock`、`/reload`、`data get`；`check=true` 只解析（语法与补全建议，不执行）；`via=chat` 从客户端聊天发送，结果用 `mc_chat` 读 |
| `mc_inspect` | `status`；`player` 玩家完整状态（模式、无敌、生命吸收、饥饿、经验、效果、背包、视线）；`registry`、`block`、`entities` |
| `mc_options` | 客户端选项：`lang`、`guiScale`、`renderDistance`、`fov`、`gamma`、`hideGui` 等。运行时经伴随 mod 当场生效，游戏没在运行时改 `run/options.txt` |
| `mc_test` | 跑 GameTest：`filter` 过滤、`side=server/client/both`，自动停/重启开发客户端，返回通过数与 junit 报告路径 |
| `mc_world` | 开发存档：`list`、`import`（用户指定的外部存档复制成只读副本）、`snapshot`/`snapshots`/`restore`/`delete_snapshot` |
| `mc_texture` | `view` 放大看贴图（坐标网格 + 调色板 + 字符像素图）；`write` 用调色板和字符图画贴图 |
| `mc_logs` | 读日志（可按级别、正则过滤）或 `crash=true` 读崩溃摘要 |
| `mc_source` | 搜索和阅读反编译的 Minecraft / 依赖源码；第一次用 `action=gen_sources` |
| `mc_mapping` | yarn / intermediary / official / mojmap 名字互查，支持 `Class#member` |

## 一轮开发

1. 读项目的 `gradle.properties` 确认 Minecraft 版本和映射（yarn 还是 mojmap），API 名字以此为准；不确定的类名、方法名先用 `mc_source` 或 `mc_mapping` 查，不要凭记忆写。
2. 改代码或资源。
3. `mc_apply`。看返回：
   - 「已热替换」：直接 `mc_view` 验证。split source sets 项目里每个类名后面标了它属于 `client` 还是 `main` 侧。
   - 「需要重启」：说明原因（见下表），用 `mc_run action=restart` 或 `mc_apply restart_if_needed=true`。
   - 编译错误：按错误改，再 `mc_apply`。
4. `mc_view` 截图或渲染，把图给用户；需要时用 `mc_command give` 拿到物品再截图。
5. 出现崩溃或报错：按 [troubleshooting.md](troubleshooting.md) 排查。

游戏没在运行时，`mc_apply` 只编译，改动下次启动生效；需要看效果就先 `mc_run action=start`。

## 开发世界与环境

`mc_run action=start` 建的 `inkstone-test` 是平坦、关掉昼夜与刷怪的创造世界；客户端语言看 `run/options.txt`（新装默认 `en_us`），世界难度默认和平。这些默认值都可以改：

- 一次调好：`mc_run action=start gamemode=survival difficulty=normal lang=zh_cn time=noon weather=clear`。`lang` 在启动前写进 `options.txt`，其余进世界后用命令设，返回里会逐条写明成功还是失败。
- 运行中改：`mc_command difficulty normal`、`mc_command gamemode survival`、`mc_command time set day`、`mc_options set={"lang":"zh_cn"}`（语言要重载资源）、`mc_options set={"guiScale":"3"}`。
- 和平难度不能召唤怪物（`Monsters cannot be summoned in Peaceful difficulty`），也不能让玩家受伤；测战斗、测伤害先 `difficulty normal`。
- `mc_run action=status` 给当前环境（世界、版本、维度、模式、难度、语言、坐标、是否暂停）和性能，不用靠猜。

## 验证套路：命令搭现场，输入与界面触发

验证要来自真实输入和界面，不要用命令伪造要测的效果，再用截图假装通过。

1. **搭现场**：`mc_command` 摆方块、给物品、召唤生物、设时间天气；环境用 `mc_run` 的 `gamemode`/`difficulty`/`time`/`weather`。
2. **触发**：按键用 `mc_input`（`key`、`attack`、`use`、`move`、`hotbar`、`look`），界面用 `mc_ui`（`open`、`click`、`type`），要客户端命令就 `mc_command via=chat`。
3. **断言**：`mc_inspect what=player`（模式、无敌、生命、效果、背包）、`mc_ui read`（界面与槽位）、`mc_chat`（聊天与系统提示）、`mc_perf`（性能），最后 `mc_view` 截图。
4. **看变化就连拍**：倒计时、粒子、动画、进度条用 `mc_view target=screen count=4 intervalMs=500`，每张带时间戳和间隔；HUD 挡住画面加 `hideHud=true`，只看一角用 `crop=[x,y,w,h]`。
5. **要精确顺序**（按住若干 tick 再松开、开界面点到具体槽位）用 `mc_script`，一条调用里跑完整串并带回每步结果与截图。
6. **命令写不准先 `check`**：`mc_command check=true` 只解析，返回能不能解析、错在哪个字符、补全建议。
7. **进不去状态先查玩家**：`mc_inspect what=player` 看是不是创造模式（不掉血）、无敌、和平难度，或 `mc_ui read` 看是不是还开着某个界面。

## 看得准：网格、高亮、等待

- **点自定义界面先开网格**：要数坐标、点自己画的按钮或 HUD 元件时，先 `mc_view target=screen grid=true`（要更细用 `grid={"step":25}`）。网格和刻度只叠在返回的图片上，不画进游戏画面；坐标是 GUI 缩放后的屏幕坐标，和 `mc_ui click` 的 `x`/`y` 同一套，量出来直接点就行。`mc_script` 的 `screenshot` 步同样支持 `grid`，按住若干 tick 再点一串坐标时可以一次跑完。
- **测试对象先高亮**：`mc_highlight action=entity selector=@e[type=mymod:ruby_golem,limit=1,sort=nearest]`（或用 `uuid` 盯住同一个实体）圈出实体，`action=block pos=[x,y,z]` 给方块描框，`color` 写 `#rrggbb`，`seconds` 默认 30、上限 600。高亮只影响渲染、不改实体与方块的存档数据，截图里和用户屏幕上都能看到；验证完 `action=clear` 收干净。
- **用 `mc_wait` 代替反复截图轮询**：等界面打开、等聊天提示、等生物生成、等血量掉到阈值，都用一次 `mc_wait` 拿结论，不要循环 `mc_view`/`mc_ui read` 猜。`until` 取 `in_world`（进世界且可操作）、`screen`（配 `screen` 匹配界面类名或标题，不填表示任意界面）、`no_screen`、`chat`（配 `match`，`since` 用上次 `mc_chat` 的 `latest` 避免拿到旧消息）、`ticks`、`entity`（配 `selector`）、`player`（配 `field` 与 `equals`/`lt`/`gt`，例如 `field=health lt=10`）。`timeout_ms` 默认 30000、`poll_ticks` 默认 2。超时返回第一行「等待超时」加当时现场，先查状态（`mc_ui read`、`mc_inspect what=player`、`mc_chat`）再决定，别直接加大 timeout 重试。

## 放慢与单步

看不清的短过程（方块被推走的一瞬、实体刚生成的一帧、红石脉冲、自己写的 tick 逻辑）用 `mc_tick` 放慢或冻住，而不是堆截图数量。

- **慢下来看**：`mc_tick action=rate rate=2`（每秒 2 tick，比正常 20 慢 10 倍），配合 `mc_view target=screen count=4 intervalMs=1000` 连拍；看完 `action=rate rate=20` 调回。
- **冻住单步**：`freeze` → `step ticks=N` → 截图，是精确观察的标准套路。冻结后游戏逻辑完全不推进（只有 `step` 推），画面上什么都不会再变，方便逐帧对比：

  ```text
  mc_tick action=freeze
  mc_script steps=[{op:"tick",action:"step",ticks:1},{op:"screenshot"},{op:"tick",action:"step",ticks:1},{op:"screenshot"}]
  ```

- **一次跑一大段**：`sprint ticks=200` 让游戏用高速把 200 tick 跑完（适合跳过等待又不想按真实时间等），`sprint stop=true` 提前结束。
- **什么时候不该用 `mc_tick`**：tick 只影响游戏逻辑（实体、方块、红石、模组 tick 逻辑），不影响渲染帧率，也不影响按真实时间计时的界面动画（toast 淡出、部分 HUD 动画、粒子插值）。这类短暂界面冻结也停不住，用 `mc_wait` 等到状态出现，再用 `mc_script` 的 `screenshot` 步在同一条调用里截下来。
- **测完必须 `reset`**：`mc_tick action=reset` 解除冻结并把速率调回 20。留着冻结或低速会让后续一切测试看着像卡死（`mc_run action=stop/restart` 前也会提醒）。

## 用户接管

开发客户端是 agent 实例：窗口标题带 `Inkstone Agent`，默认右下角小窗、不抢焦点，退到后台输入模式启动（JVM 属性 `-Dinkstone.input=background`）：agent 的点击、按键与转视角只改游戏内部状态，不挪用系统鼠标、不把光标锁成 `GLFW_CURSOR_DISABLED`，你平时能照常用鼠标；要测原版那种锁定光标的行为再改成 `-Dinkstone.input=foreground`。启动后控制方是 agent，游戏里左上角有一条半透明提示「Agent 正在操作 · 按 F8 接管」，锁定期间用户的鼠标键盘不生效。

用户按 F8（或在开发页点「我来操作」）后控制方变成用户，这时：

- `mc_command`、`mc_run action=stop/restart`、`mc_apply` 的自动重启会被拒绝，返回「用户正在操作开发客户端（按 F8 或在开发页点「交还 Agent」后再试）」；`mc_input`、`mc_ui`（除 `read`）、`mc_script`、`mc_highlight`、`mc_wait`、`mc_options` 的 `set`、`mc_world` 的 `snapshot`/`restore`、`mc_test` 也一样。`mc_wait` 在等待中途被接管会立刻返回这句拒绝，不会一直挂到超时。
- 编译、热替换、`mc_logs`、`mc_inspect`、`mc_ui read`、`mc_source` 照常；`mc_view` 的截图会附一句「用户正在操作，画面可能已被改变」。

遇到这个提示就停下来，把当前进度和需要用户确认的事说清楚，等用户交还。不要反复重试，也不要为提高效率而调用 `mc_run action=take_control` 抢回控制——只有用户明确同意（例如说「你继续」）之后才用。

## 用户指定的存档

用户给的存档（启动器实例的 `saves`、别人的存档目录之类）**永远只读**：不直接启动、不写入、不在里面测东西。

1. `mc_world action=list` 看开发存档里有什么。
2. `mc_world action=import source=<世界文件夹>` 复制成开发存档：会读 `level.dat` 的 DataVersion 和项目版本比较，存档更新会被拒绝（降级会损坏），更旧会提示「会被升级」；重名自动加后缀，也可以 `name` 指定名字。
3. `mc_run action=start world=<导入后的名字>` 进入。
4. 试验前先拍快照：`mc_world action=snapshot world=<名字> label=baseline`（会先 `save-all flush` 落盘）；改坏了 `mc_world action=restore world=<名字> snapshot=<id>` 回来，恢复前会自动把当前状态存成 `before-restore`。
5. 把改动交给用户时，告诉用户原存档没被碰过、副本叫什么。

## 能热替换还是必须重启

工具会自动判断并在结果里写明原因，下表用来提前规划改法、向用户解释。「实测」指在 1.21.1 + 普通 JDK 21 上验证过。

| 改动 | 普通 JDK | JBR（增强热替换） | 处理 |
| --- | --- | --- | --- |
| 方法体里的逻辑、常量值、渲染代码 | 可以（实测） | 可以 | `mc_apply` |
| Mixin 注入方法的方法体 | 可以（实测，自动挂 Mixin agent） | 可以 | `mc_apply` |
| 新增/删除方法、改方法签名 | 不行（实测） | 可以 | 重启或用 JBR |
| 新增 lambda、方法引用（编译器会生成新方法） | 不行（实测） | 可以 | 同上 |
| 新增/删除字段、改字段类型 | 不行 | 可以 | 同上 |
| 改父类、接口、枚举常量 | 不行 | 不稳定 | 重启 |
| 新增类 | 新类首次被用到时正常加载 | 同左 | `mc_apply` |
| Mixin 新增方法/字段、改 `@Inject` 目标或 `@At` | 不行（实测） | 不行 | 重启 |
| `onInitialize`、静态初始化、构造器里的逻辑（含注册） | 替换成功但不会再执行 | 同左 | 重启 |
| 新物品、方块、实体等注册项 | 注册表已冻结 | 同左 | 重启 |
| `fabric.mod.json`、`*.mixins.json`、access widener | — | — | 重启（自动判定） |
| `assets/`：贴图、模型、blockstates、语言、声音 | 资源重载（实测） | 同左 | `mc_apply` |
| `data/`：配方、战利品表、标签、进度、函数 | `/reload`（实测） | 同左 | `mc_apply` |
| 世界生成、维度、伤害类型、附魔等动态注册表 | `/reload` 不更新 | 同左 | 重启，常常还要新世界 |

规律：只改「已经在跑的方法里面」的东西可以热替换；改「有哪些方法和字段」、或改「只在启动时执行一次」的代码要重启。为了少重启，可以把要反复调的数值和绘制逻辑放进普通方法体，而不是静态字段初始化。

没有 JBR 时 `mc_run action=status` 会给出下载来源和放置位置（第一次 `start` 也会给一次，之后 `start`/`stop` 不再重复这段）。不要替用户下载 JBR，告诉用户来源和大小，由用户决定。

## 贴图

- 物品贴图通常 16×16。先 `mc_texture view` 看原版同类贴图（如 `minecraft:item/diamond`）学配色和轮廓：深色描边、2–4 级明暗、左上高光。
- 画新贴图用 `mc_texture write`：调色板键是单个字符，`.` 为透明，每行长度相同。写完 `mc_apply` 重载，再 `mc_view target=item` 看游戏内效果。
- 改已有贴图：先 `view` 拿到字符图，改需要的行再 `write`，保留其余像素。

## 规范和坑

先看 `gradle.properties` 的 `minecraft_version`，再读对应文件。动手写注册、配方、Mixin、资源 JSON 前先读它：

- 1.21.x（yarn 或 mojmap）：[fabric-1.21.md](fabric-1.21.md)
- 26.x（不混淆、官方名、JDK 25、GameTest）：[fabric-26.md](fabric-26.md)

伴随 mod 支持 1.21–1.21.1 和 26.1.x（按项目版本自动选用、首次自动构建）。其他版本上 `mc_apply` 的编译和热替换照常可用，但截图、渲染、资源重载、执行命令不可用，`mc_run` 也不会自动建测试世界；这时用 GameTest 的截图和日志验证。

26.x 的 `mc_view target=item/block` 走游戏的界面物品渲染：结果边长不超过窗口高度，3D 方块放大后会有像素感；没有物品形态的方块（如水、火）渲染不了。渲染时会短暂切到一个纯色界面，结束后回到原来的画面。
