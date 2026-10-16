# v3 命令面板与快捷键

两个部件，共用同一份纯逻辑与文案：

- `CommandPalette` —— 独立可挂载的模态命令面板：搜索操作 / 会话 / 消息、键盘上下选择、
  Enter 执行、失败留在面板里显示原因。它调用正式 store 动作，路由交回父 Shell。
- `ShortcutSheet` —— `Ctrl+/` 的只读快捷键表，全局组来自 `app/shortcuts.ts` 注册表，
  输入框 / 审批 / 终端三组复用 `lib/host-actions.ts` 的 `SHORTCUT_NOTE_GROUPS`。

> **状态：已接入 `app/ShellV3.tsx`。** `Ctrl+K` 打开面板，`Ctrl+/` 打开快捷键表，
> Esc 关闭并归还焦点；搜索侧栏命令由外壳先展开侧栏，再于下一帧聚焦。

## 命令面板

### 前缀模式（02 §13.1）

| 前缀 | 模式 | 内容 |
| ---- | ---- | ---- |
| （无） | 默认 | 空查询只列操作；输入后操作 + 会话一起过滤 |
| `>` | 操作 | 只看操作 |
| `@` | 会话 | 只看会话（标题 / 项目 / 路径） |
| `#` | 消息 | 搜**当前视图**会话内的消息，选中定位到该条 |
| `?` | 帮助 | 列出这段前缀说明，选中把前缀写回查询 |

### 操作覆盖

- 新建会话、搜索侧栏、展开 / 收起侧栏、展开 / 收起工作区
- 切换到浅色 / 深色主题、运行总览、打开设置
- 工作区各页签：改动 / 终端 / 文件 / 浏览器 / 预览
- 设置各分区：外观 / 模型与服务 / 能力 / 用量
- 停止当前会话 —— **只在当前视图就是运行实例时出现**（peek 别的会话不误停后台运行）

只列 v3 当前确能执行的动作。v2 的宿主动作表、斜杠命令、需要额外授权的旧计划任务
命令都不在列表里，也不会被面板执行。终端 / 浏览器页签的打开只经由
`features/workbench/activation` 的正式激活流程；未激活就如实失败。

### 接口

```ts
import { CommandPalette } from '../features/commands/CommandPalette'

<CommandPalette
  isOpen={paletteOpen}
  onOpenChange={setPaletteOpen}
  onNavigate={(route) => useUiV3.getState().navigate({ name: route })}
/>
```

| prop           | 说明                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `isOpen`       | 由父 Shell 持有；组件在 `false` 时返回 `null`。                       |
| `onOpenChange` | RAC 模态在 Esc / 点遮罩 / 执行成功后回调，父 Shell 据此收面板。       |
| `onNavigate?`  | 面板只**请求**路由跳转 `'chat' \| 'runs' \| 'settings'`。            |

工作区 / 侧栏是外壳界面状态，面板直接调 `state/ui-v3` 的正式动作；会话切换走
`store.switchSession`，消息定位走 `store.locateMessage`，主题 / 设置走 `store`。

## 快捷键表

`Ctrl+/` 打开。全局组的每行直接来自 `app/shortcuts.ts` 的 `SHORTCUTS`（与 ShellV3
实际绑定同源），输入框 / 审批 / 终端三组来自 `lib/host-actions.ts`。键位设置页尚未实现，
所以表是只读的。

## 外观与层归属

`command-palette.css` / `shortcut-sheet.css` 全部用 design/tokens.css 的变量：

- `@layer patterns`：容器与列表行**外观**（底色、描边、圆角、阴影、悬停/选中底色、
  次要文字与错误文字颜色）。按合同这部分归 patterns 层；因本任务不能新增/修改
  `patterns/`，暂放在本目录文件里，合并时可原样挪走，选择器不变。
- `@layer features`：模块**版面**（flex / grid / 间距 / 高度 / 滚动 / 字号）。

搜索框用原生 `<input role="combobox">`（需要 `aria-activedescendant` 指向列表项，
`ui/SearchField` 没有透传该属性的入口）；快捷键徽标用 `ui/Kbd`，转圈用 `ui/Spinner`，
模态外壳用 `ui/Dialog` + `ui/Modal` + `ui/ModalOverlay`（RAC 负责焦点归还与 Esc）。

## 已知限制

- 只按**标题 / 目录 / 路径**搜会话，不搜正文（正文检索是 v2 `SessionSwitcher` 的能力，
  未迁移）。
- 消息检索只覆盖当前视图的 `store.messages`，不读别的会话历史文件；`#` 空查询不铺历史。
- 动作执行期间锁重入（同一时刻一个动作）；失败保留面板并显示原因。外壳通过
  `NoticeBridge` 将既有 store 提示转交 `ui/ToastRegion`，不新增一套通知事实。
- 「搜索侧栏」依赖父 Shell 展开侧栏，见上。
- `Ctrl+J` 打开的是**运行总览页**；会话头的运行浮层状态归 `app/Header.tsx` 私有，
  未共享，所以快捷键暂不打开浮层。
- 键位设置页与全局快速提问窗口尚未实现。

## 检查

```bash
node scripts/test-v3-command-items.mjs   # 纯逻辑：分词 / 打分 / 排序 / 分组 / 上限 / IME
node scripts/test-v3-shortcuts.mjs       # 纯逻辑：注册表 / 冲突 / 精确匹配 / 前缀解析
npx tsc --noEmit -p tsconfig.web.json    # 渲染端类型检查
npm run check:styles:v3                  # v3 值依赖隔离
```
