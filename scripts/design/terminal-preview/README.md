# 终端风格界面原型

[界面重构计划](../../../docs/UI_REDESIGN.md) 对应的设计画板源码，只作实现参考，不参与构建。

| 文件 | 内容 |
| --- | --- |
| `Main.dc.html` | 工作台 1440×900：一轮完整运行演示，所有面板由同一时钟驱动 |
| `Components.dc.html` | 色阶、字体分工、按钮、分段、徽标、工具行状态、命令面板、状态栏 |
| `Motion.dc.html` | 动效令牌与演示：展开、逐字输出、方点阵、环绕流光、交叉淡变、滑块、浮层开合 |
| `Icons.dc.html` | 「砚线」图标规范：母题、规则、现状审计、新旧对照与首批 48 个图标 |

这些文件是 Design Component 格式（`<x-dc>` 模板 + `class Component extends DCLogic`），需要设计画布的运行时才能渲染，直接用浏览器打开不会显示完整画面。实现时从中取用 CSS 片段（`@keyframes`、`.spin`、`.orbit`、`.grow`）、版面结构与演示时间轴；颜色与尺寸以 `src/renderer/src/styles/tokens.css` 为准。

图标几何的机器可读版本在 [`../icons/inkline.draft.json`](../icons/inkline.draft.json)。
