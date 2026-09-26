# 第三方许可

砚本身以 [MIT](../../LICENSE) 发布。本文件登记**随分发保留**的第三方组件及其许可，只做索引，不替代各组件原始许可文本。

## 图标

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| [Lucide](https://lucide.dev)（npm 包 `lucide-static`） | 1.48.0 | ISC |

- 界面图标的几何全部来自 Lucide。完整许可文本见 [`scripts/design/icons/LICENSE-lucide.txt`](../../scripts/design/icons/LICENSE-lucide.txt)（其中也包含 Lucide 派生自 [Feather](https://feathericons.com) 的那部分图标所适用的 MIT 条款）。
- 语义 → 图标的映射写在 [`scripts/design/icons/catalog.json`](../../scripts/design/icons/catalog.json)，由 `npm run icons` 在构建期生成 `src/renderer/src/icons/sprite.ts`。图标因此是构建产物、不是运行时依赖，但许可声明仍需随分发保留。
- 2026-09-27 之前的图标来自 [reicon](https://reicon.dev)（MIT 声明，但包内未附 LICENSE 文件），已整体替换为 Lucide。

## 其它运行时组件

| 组件 | 许可 |
| --- | --- |
| React / React DOM / Zustand 等 npm 依赖 | 各自包内声明（多为 MIT） |
| highlight.js | BSD-3-Clause |
| Maple Mono CN（`@mogeko/maple-mono-cn`） | 见包内声明 |
| node-pty | 见包内声明 |
| 内置 pi 运行时（`resources/pi-runtime/`） | 见上游项目声明 |

完整许可文本随各自分发包一起保留；升级依赖时请同步核对本表。
