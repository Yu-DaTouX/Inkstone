# 排错流程

先定位是哪一类问题，再查对应的位置。不要在没看日志的情况下猜。

## 编译失败

`mc_apply` 或 `mc_build` 返回的错误里有文件和行号。找不到符号时：

1. `mc_mapping name=<名字>` 看当前映射里叫什么（yarn 与 mojmap 名字常不同，教程可能用的是另一套）。
2. `mc_source action=search query=<方法名>` 在反编译源码里找真实签名；版本间 API 变化很常见。

## 启动时崩溃

1. `mc_logs crash=true`：看 Description、异常和「可疑栈帧」（非原版的帧，通常就是你的类）。
2. 没有崩溃报告但进程退出：`mc_logs level=error`，再看最后 80 行。
3. 常见原因：
   - `Mixin apply failed` / `InvalidInjectionException`：注入目标或签名不对，对照 `mc_source` 改。
   - 注册相关异常：注册写在了错误的时机，或 1.21.2+ 缺 `registryKey`。
   - `NoClassDefFoundError` 指向客户端类：主入口引用了客户端代码。
   - `fabric.mod.json` 依赖不满足：日志开头会列出缺什么。

## 运行中崩溃或报错

- `mc_logs filter=<你的包名>` 找带你代码的堆栈。
- 改完后 `mc_apply`，崩溃过的客户端需要 `mc_run action=start` 重新启动。

## 贴图是紫黑格子

紫黑表示找不到贴图或模型。依次检查：

1. `mc_view target=item id=<modid>:<name>` 确认是贴图问题还是模型问题。
2. 文件路径：`assets/<modid>/textures/item/<name>.png`，全小写，命名空间和 mod id 一致。
3. 模型里的引用：`"layer0": "<modid>:item/<name>"`，不带 `textures/` 和 `.png`。
4. 1.21.4+ 是否缺 `assets/<modid>/items/<name>.json`。
5. `mc_logs filter="Missing|Unable to load model|Couldn't load"` 看资源加载报错。

物品显示成 `item.<modid>.<name>` 这样的原始键：语言文件缺条目或 JSON 格式错。

## 配方、战利品表、标签不生效

1. 目录是不是单数（`recipe/`、`loot_table/`、`tags/item/`）。
2. `mc_logs filter="Couldn't parse|Parsing error|recipe"` 看解析错误。
3. `mc_command recipe give @s <modid>:<name>` 或打开工作台验证；标签用 `mc_inspect what=registry` 或命令确认。

## 热替换没生效

- `mc_apply` 结果里 `skippedNotLoaded` 表示那个类还没被加载，下次用到时自然是新代码。
- 显示已替换但画面没变：改的是只执行一次的代码（`onInitialize`、静态初始化、注册），需要重启。
- Mixin 热替换失败：`mc_logs filter=MixinAgent` 看原因，通常是新增了方法或改了注入点，重启即可。
- 资源改了没变化：确认 `mc_apply` 结果里有「资源已重载」；若贴图被别的资源包覆盖，检查命名空间。

## 状态或效果不对劲

- 召唤不出怪物、玩家不掉血：开发世界默认和平难度 + 创造模式。`mc_inspect what=player` 看当前模式、无敌、生命；要测战斗先 `mc_command difficulty normal` 和 `mc_command gamemode survival`，或者启动时就 `mc_run action=start difficulty=normal gamemode=survival`。
- 命令报 `Target is invulnerable`、`No entity was found`：先 `mc_inspect what=player` 确认模式与位置，再 `mc_inspect what=entities type=<类型>` 看目标在不在；命令写不准用 `mc_command check=true` 看解析错误、位置与补全建议。
- 按键没反应、看不到世界：`mc_ui read` 看当前开着什么界面（未关闭的界面会吃掉输入），`mc_ui close` 或 `mc_input key=escape` 关掉再试。
- 客户端语言或选项不对：运行中 `mc_options set={"lang":"zh_cn"}`（要重载资源），启动前用 `mc_run action=start lang=zh_cn`；`mc_run action=status` 的环境行有当前语言、难度、模式。
- 只能看到一瞬间的变化（倒计时、粒子、动画）：用 `mc_view target=screen count=4 intervalMs=500` 连拍，每张带时间戳；需要 tick 级顺序用 `mc_script` 把命令、输入、等待、截图串起来。

## 告诉用户

报告问题时给出：现象（截图或日志原文几行）、原因、改了什么、验证结果（新截图）。
