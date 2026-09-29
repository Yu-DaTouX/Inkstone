# 第三方许可

砚本身以 [MIT](../LICENSE) 发布。本文件登记**随分发保留**的第三方组件及其许可，只做索引，不替代各组件原始许可文本。

## 图标

- 界面图标是本仓库自绘的「砚线」，随砚以 MIT 发布，不含第三方几何。几何写在 [`scripts/design/icons/inkline.json`](../scripts/design/icons/inkline.json)，语义写在 [`catalog.json`](../scripts/design/icons/catalog.json)，由 `npm run icons` 在构建期生成 `src/renderer/src/icons/sprite.ts`。
- 2026-09-28 之前的版本使用 [Lucide](https://lucide.dev)（ISC，npm 包 `lucide-static`），更早使用 [reicon](https://reicon.dev)。分发这些旧版本时，其许可声明仍随对应版本保留。

## 其它运行时组件

| 组件 | 许可 |
| --- | --- |
| React / React DOM / Zustand 等 npm 依赖 | 各自包内声明（多为 MIT） |
| highlight.js | BSD-3-Clause |
| Maple Mono CN（`@mogeko/maple-mono-cn`） | 见包内声明 |
| node-pty | 见包内声明 |
| 内置 pi 运行时（`resources/pi-runtime/`） | 见上游项目声明 |

完整许可文本随各自分发包一起保留；升级依赖时请同步核对本表。
