# v3 基础原语（`ui/`）

只放**控件外观与交互**，版面归 `patterns/` 与 `features/` 的模块 CSS。

## 规矩

- 交互、焦点、键盘与 ARIA 一律交给 **React Aria Components（RAC）**；图标用 **lucide-react**。
- 颜色/间距/圆角/字号/动效只取 `design/tokens.css`（由 `design/tokens.json` 生成）的变量，
  不在这里写死色值，也不私造变量。
- 每个组件都接受并合并调用方的 `className`；`features/` 只加版面类，不改控件外观。
- 组件样式只来自 `./ui.css`（含它聚合的 `Slider.css` / `Tree.css`）或组件自带的
  `Table.css` / `Splitter.css`，统一落在 `@layer primitives`。`index.ts` 是唯一入口，
  它引入 `./ui.css`。

## 共享接口（合同要求）

`Button` `IconButton` `TextField` `Dialog` `Popover` `Menu` `MenuItem`
`Tabs` `TabList` `Tab` `TabPanel` `Tooltip`

其余可用原语：`TextArea` `SearchField` `Checkbox` `CheckboxGroup` `Switch` `Radio`
`RadioGroup` `Select` `ComboBox` `ListBox` `ListBoxItem` `ListBoxSection` `MenuSection`
`MenuTrigger` `SubmenuTrigger` `DialogTrigger` `ModalOverlay` `Modal` `TooltipTrigger`
`ToastRegion` `showToast` `Badge` `Kbd` `ProgressBar` `Meter` `Spinner` `Skeleton` `Separator`
`Slider` `Splitter`。集合类：`Tree` `TreeItem` `TreeItemContent` `TreeChevron` `TreeItemLabel`
`TreeSection` `TreeHeader` `TreeEmptyState`，以及 `Table` `TableHeader` `Column` `TableBody`
`Row` `Cell` `TableFooter` `TableEmptyState` `TableLoadingState`（排序用纯函数 `sortRows`）。
另外转出无外观的 RAC 构建块：`Label` `Input` `Text` `FieldError` `Header` `Heading`。

## 样式挂载

`index.ts` 是唯一入口，它引入 `./ui.css`。控件外观都落在 `@layer primitives`：

- 多数原语的规则直接写在 `ui.css` 里；
- `Slider` 与 `Tree` 各有自己的 CSS，由 `ui.css` 顶部的 `@import` 聚合挂载；
- `Table` 与 `Splitter` 由各自组件 `import './Table.css'` / `import './Splitter.css'` 自带，
  因此 `ui.css` 不再重复导入它们。

## 常用写法

```tsx
import { Button, IconButton, Dialog, DialogTrigger, Modal, ModalOverlay, TextField, Tooltip, TooltipTrigger } from '../ui'
import { Settings } from 'lucide-react'

// 主按钮（墨色，唯一主动作） / 次按钮 / 无框 / 危险
<Button variant="primary" onPress={send} isPending={sending}>发送</Button>
<Button variant="danger" onPress={removeAll}>全部移除</Button>

// 图标按钮必须给 aria-label；title 只是原生悬停提示
<IconButton aria-label="设置" title="设置" onPress={openSettings}><Settings size={16} /></IconButton>

// 提示：延迟 500ms，悬停与键盘聚焦都出现，不捕获焦点
<TooltipTrigger delay={500}>
  <IconButton aria-label="收起侧栏">…</IconButton>
  <Tooltip>收起侧栏 Ctrl+B</Tooltip>
</TooltipTrigger>

// 对话框：Esc 与点遮罩关闭、关闭后焦点归还触发元素，由 RAC 的 ModalOverlay 保证
<DialogTrigger>
  <Button>改名</Button>
  <ModalOverlay isDismissable>
    <Modal>
      <Dialog title="重命名会话">{(renderProps) => <TextField label="名称" />}</Dialog>
    </Modal>
  </ModalOverlay>
</DialogTrigger>
```

## 状态约定

- 禁用：`isDisabled`（RAC 会处理 `aria-disabled` 与按压）。
- 加载：`isPending`（保留可聚焦，显示转圈，读屏会播报）。
- 原生提示：`Button` / `IconButton` 的 `title` 由挂载后的 ref 写到真实节点上
  （RAC 的 DOM 过滤会丢掉 `title`；应用是客户端渲染，挂载即生效）。
  需要跟随主题、延迟出现的提示请用 `Tooltip`。
- 焦点：全应用统一 2px `--accent` 焦点环、外偏移 2px，由 `[data-focus-visible]` 触发。
- 悬停只在指针设备出现（`@media (hover: hover)`）。
- 「减少动态效果」下关掉全部原语动画。
- 可关闭页签：`<Tab onClose={…}>`。切换与关闭是两个独立按钮；键盘上焦点在页签时按
  `Delete` / `Backspace` 关闭。

## 待办与限制（如实标注）

- `Tree` / `Slider` / `Splitter` 已有实际调用点（分支树、引导向导、并排会话分隔条）；
  `Table`（虚拟化/排序）目前只有原语与故事，尚未接入调用点。
- 侧栏会话列表虚拟化方案（React Aria Virtualizer vs virtua）未比较。
- Storybook 只用于开发期预览（`npm run storybook`）；`npm run test:stories` 是 CSF 与结构声明的
  静态守卫，不代表 play / a11y / 截图已验。
- `Toast` 用的是 RAC 的 `UNSTABLE_*` API，升级 RAC 时需要复核。
- `.ui-spinner` / `.ui-skeleton` 的循环动画用了裸时长（令牌里没有对应值），
  已在 `prefers-reduced-motion` 下关闭。
