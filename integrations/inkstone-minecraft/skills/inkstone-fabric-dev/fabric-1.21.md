# Fabric 1.21.x 规范与常见坑

以项目 `gradle.properties` 里的版本为准。下文默认 yarn 映射；mojmap 项目的类名不同（如 `Identifier` ↔ `ResourceLocation`、`MinecraftClient` ↔ `Minecraft`），用 `mc_mapping` 换算。

## 项目结构

```
src/main/java/<包>/<Mod>.java            ModInitializer，注册物品、方块、事件
src/main/java/<包>/<Mod>Client.java      ClientModInitializer，只放客户端代码
src/main/java/<包>/mixin/                Mixin 类（只能放在 mixins.json 声明的包里）
src/main/resources/fabric.mod.json
src/main/resources/<modid>.mixins.json
src/main/resources/assets/<modid>/...    客户端资源
src/main/resources/data/<modid>/...      数据包内容
```

- mod id 只能是小写字母、数字、`_`、`-`，2–64 个字符；资源路径同样只能小写，大写文件名会直接找不到。
- 客户端类（`MinecraftClient`、`Screen`、渲染相关）只能从客户端入口和客户端 Mixin 引用。主入口里引用会让专用服务器崩溃，开发客户端里看不出来。

## 注册

1.21–1.21.1：

```java
public static final Item RUBY = Registry.register(Registries.ITEM, Identifier.of(MOD_ID, "ruby"), new Item(new Item.Settings()));
public static void register() {}
```

- `new Identifier(...)` 在 1.21 已不可用，用 `Identifier.of(ns, path)`（mojmap：`ResourceLocation.fromNamespaceAndPath`）。
- 主入口 `onInitialize` 里调用 `ModItems.register()` 触发类加载，否则静态字段不会初始化，物品不存在。
- 加进创造物品栏用 Fabric API：`ItemGroupEvents.modifyEntriesEvent(ItemGroups.INGREDIENTS).register(entries -> entries.add(RUBY))`。
- 方块要同时注册 `Block` 和对应的 `BlockItem`。

版本差异：

- 1.21.2 起 `Item.Settings` / `AbstractBlock.Settings` 必须先设 `registryKey(RegistryKey.of(RegistryKeys.ITEM, id))`，否则启动崩溃，报 id 未设置。
- 1.21.4 起每个物品还要有 `assets/<modid>/items/<name>.json` 物品模型定义，只有 `models/item` 会显示紫黑方块。
- 1.20.5 起物品 NBT 换成数据组件：`new Item.Settings().maxCount(16).food(...)`、`.component(DataComponentTypes.X, value)`；命令里写 `give @s minecraft:diamond_sword[minecraft:damage=10]`，不是 `{Damage:10}`。

## 资源（assets）

物品：

```
assets/<modid>/textures/item/ruby.png
assets/<modid>/models/item/ruby.json      {"parent": "minecraft:item/generated", "textures": {"layer0": "<modid>:item/ruby"}}
assets/<modid>/lang/en_us.json            {"item.<modid>.ruby": "Ruby"}
assets/<modid>/lang/zh_cn.json            {"item.<modid>.ruby": "红宝石"}
```

方块：`blockstates/<name>.json` → `models/block/<name>.json`（常用 `"parent": "minecraft:block/cube_all"`，`"textures": {"all": "<modid>:block/<name>"}`）→ 物品模型 `models/item/<name>.json` 写 `"parent": "<modid>:block/<name>"`。语言键是 `block.<modid>.<name>`。

- 贴图引用不带 `textures/` 和 `.png`：`<modid>:item/ruby`。
- 动画贴图是竖向拼接的帧，配同名 `.png.mcmeta`。

## 数据（data）

1.21 起目录名是单数：`recipe/`、`loot_table/`、`advancement/`、`tags/item/`、`tags/block/`、`predicate/`、`function/`。旧教程里的 `recipes/`、`loot_tables/`、`tags/items/` 在 1.21 不会被读取，也不会报错。

有序合成（1.21–1.21.1）：

```json
{
  "type": "minecraft:crafting_shaped",
  "pattern": ["RR", "RR"],
  "key": { "R": { "item": "<modid>:ruby" } },
  "result": { "id": "<modid>:ruby_block", "count": 1 }
}
```

- 1.20.5 起结果用 `"id"`，不是 `"item"`。1.21.2 起原料可以直接写字符串 `"<modid>:ruby"` 或标签 `"#minecraft:planks"`，以目标版本原版数据为准：先用 `mc_source` 搜原版同类配方。
- 方块掉落要写 `loot_table/blocks/<name>.json`，否则挖掉什么也不掉。
- 改完 `mc_apply` 会执行 `/reload`；配方解析失败只在日志里报错，用 `mc_logs filter=<文件名或 Couldn't parse>` 查。

## Mixin

- 优先用 Fabric API 事件（`HudRenderCallback`、`UseItemCallback`、`ServerTickEvents` 等），没有合适事件再写 Mixin。
- Mixin 类只放在 mixins.json 的 `package` 下，并列在 `mixins`（两端）或 `client`（仅客户端）数组里；代码里不要直接引用 Mixin 类。
- 注入方法名加 `<modid>$` 前缀，避免和其他 mod 冲突。
- 目标方法名按当前映射写（yarn 项目写 yarn 名），refmap 由 Loom 生成；先 `mc_source action=read` 看目标方法签名再写 `@Inject`。
- `defaultRequire: 1` 时注入点找不到会启动崩溃，日志里搜 `Mixin` 或 `InvalidInjectionException`。

## 线程与端

- 单人游戏也有逻辑服务器线程和客户端渲染线程。改世界、实体、方块状态要在服务器端做（`world.isClient` 为 false 时），渲染和界面在客户端。
- 网络包、事件回调可能不在主线程，访问世界前用 `server.execute(...)` / `client.execute(...)` 切回去。
