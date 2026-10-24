# Fabric 26.x 规范与常见坑

26.x 起 Minecraft 不再混淆，开发和运行都直接用 Mojang 官方名（`ResourceLocation`、`Minecraft`、`GuiGraphics…`），没有 yarn，`mc_mapping` 基本用不上。Loom 插件 id 是 `net.fabricmc.fabric-loom`（不是 `-remap`）。

## 环境

- 游戏和编译都要 **JDK 25**；Gradle 不能跑在 JDK 26 上（报 `Unsupported class file major version 70`）。
- 常见 `loom { splitEnvironmentSourceSets() }`：客户端代码在 `src/client/java`，与 `src/main/java` 分开编译。`mc_apply` 会同时编译两边并热替换。
- 原版类在 Loom 缓存的两个 jar 里：`minecraft-common-deobf`（两端共用）和 `minecraft-clientonly-deobf`（`Screen`、渲染等客户端类）。`mc_source action=gen_sources` 生成源码后两边都能搜。

## API 变化（写代码前先 `mc_source` 确认签名）

- `Component` 接口没有 `withStyle`，只有 `MutableComponent` 有；`Component.literal(...)` 返回的是 `MutableComponent`。
- 界面绘制换成 extract 阶段：`GuiGraphicsExtractor`、`extractBackground` / `extractLabels`、方块实体渲染器的 `extractRenderState`。`extractLabels` 里已经是相对界面的坐标，不要再加 `leftPos/topPos`。
- 画文字的颜色参数传 **`-1`**，颜色放在 Component 的 Style 里；传 `0xRRGGBB` 时 alpha 为 0，什么都不显示。
- 画中文或特殊符号用 `Component` 重载，不要用 `String` 重载（会丢字）。
- `ItemAttributeModifiers` 是 record，隐藏 tooltip 用 `Display.hidden()`；`AttributeModifier.Operation` 是 `ADD_VALUE` / `ADD_MULTIPLIED_BASE` / `ADD_MULTIPLIED_TOTAL`。
- 包级私有的原版类只能 `@Mixin(targets = "完整类名")`；私有方法用 `@Invoker`。
- 原版物品自带无样式的 `ITEM_NAME` 组件；`DataComponents.ITEM_NAME` 写进配方/数据时会丢样式。
- 数据包里的同名标签文件是**覆盖**原版，不是合并。
- 配方 JSON 里写错的 `components` 字段会被静默忽略，只能真的合成出来检查。

## 数据附件（Fabric API `AttachmentRegistry`）

持久附件三件事缺一不可：

1. 在 `onInitialize` 里主动访问一次附件所在类的静态字段，否则读档时附件类型还没注册，值被静默丢弃（日志 `Skipping invalid attachments`）。
2. 在玩家复活/换维度复制（`ServerPlayer#restoreFrom` 的 Mixin）里手动搬过去，否则死亡即清空。
3. 需要死亡不掉落的，接进自己的死亡保护逻辑。

## 自动测试（Fabric GameTest）

- 优先用 `mc_test` 跑：`filter` 传过滤条件，`side=server`（默认，一般是 `runGametest`）或 `client`（`runClientGametest` 这类）或 `both`，`task` 可以直接指定 Gradle 任务名。它会先看项目挑 JDK、必要时先把开发客户端停掉，返回通过数、失败项和 `junit.xml` 路径；`restart_client=true` 时跑完自动重启回原来的世界。`mc_test action=list` 只看检测到的运行配置和客户端状态，不跑。
- 过滤参数有**两套**，先看项目自己的 build.gradle 与文档：
  - 项目自定义的过滤属性（例：`-Pfilters="thepit:*combat*"`，客户端 `-Pcfilters=<子串>`）——项目有自定义就按项目的写法，`mc_test` 会把 `filter` 当项目参数传。
  - Fabric API 原生 `-Dfabric-api.gametest.filter=<命名空间>:<通配符>`——项目没自定义时用；只对项目把它转发给游戏 JVM 的构建生效。
  - 两套不通用：项目用自己的属性时再叠 `-D` 不会过滤，只能看到 0 项通过。服务端过滤是**通配符不是正则**、**必须带命名空间**、**一次一个**；测试名是方法名的 snake_case（`notAGladiator` → `not_agladiator`），拿不准就写短一点。
- 新测试类要登记到 `fabric.mod.json` 的 `fabric-gametest` 入口，否则不会运行，总数不变也看不出来。
- 超过 20 tick 的测试要写 `@GameTest(maxTicks = N)`；装备属性要过 1 tick 才生效，用 `runAtTickTime`。
- 假玩家（mock player）不吃伤害，`hurtServer` 恒为 false，断言会假通过：改测纯函数或用普通生物；创造模式同样不结算伤害。
- 亡灵生物对瞬间伤害药水是治疗；投掷物要给朝向目标的速度才会命中。
- 客户端测试 `runClientGametest` 用 `context.takeScreenshot(name)` 出图，单次约 40 秒；服务端测试跑 en_us、客户端测试跑 zh_cn。
- 测试被中断会残留 gametest 进程锁住世界目录，下次报 `LevelStorageSource.validateAndCreateAccess`：结束残留的 java 进程即可（先确认不是用户自己的游戏）。

日常调界面和数值用 `mc_apply` 热替换（秒级），用 `mc_view` 截图确认，定稿后再用 `mc_test` 跑相关 GameTest 收口。开发客户端里的测试世界是平坦创造世界、关闭了昼夜和刷怪、和平难度；验证受伤类效果要先 `mc_run action=start difficulty=normal gamemode=survival`（或运行中 `mc_command difficulty normal` + `mc_command gamemode survival`）。

## 工具链

- 源文件可能是 CRLF：多行文本替换容易匹配失败，用单行锚点。
- `gradle.properties` 改了版本号后，configuration cache 可能还产出旧文件名：核对 `build/libs` 里的版本号。
- 替换启动器 mods 目录里的 jar 前，先确认游戏没在运行（jar 被占用删不掉），有用户的游戏在跑就先问。
