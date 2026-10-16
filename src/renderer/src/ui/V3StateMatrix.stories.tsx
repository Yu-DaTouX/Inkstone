import type { ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Badge,
  Button,
  Dialog,
  DialogTrigger,
  Header,
  Heading,
  IconButton,
  Kbd,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Meter,
  Modal,
  ModalOverlay,
  Popover,
  ProgressBar,
  Separator,
  showToast,
  Skeleton,
  Spinner,
  SubmenuTrigger,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  ToastRegion,
  toastQueue,
  Tooltip,
  TooltipTrigger
} from './index'

/**
 * v3 原语逐状态矩阵（组件工作台）。
 *
 * 覆盖 `ui/index.ts` 现有正式导出的交互与呈现状态：默认 / 悬停 / 按下 /
 * 键盘焦点 / 禁用 / 加载 / 选中 / 错误 / 只读，以及浅色·深色与三档密度。
 * 外观全部来自 `tokens.css` 与 `ui.css`，本文件只写版面，不写控件皮肤。
 *
 * 诚实边界：hover / press / focus / open 这类无法在静态故事里稳定复现的状态
 * 只通过 `parameters.stateMatrix.declared` 声明，没有被指针或键盘实测；
 * 本文件不调用宿主 API，数据全部是固定本地样例。配套的
 * `scripts/test-v3-story-coverage.mjs` 只做「能解析 + 覆盖清单一致」的静态核对，
 * 不代替 Storybook 交互测试、a11y 扫描或视觉验收。
 */
const meta = {
  title: 'v3/状态矩阵',
  parameters: { layout: 'padded' }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const STATES = (...names: string[]) => names

/* ---------- 按钮 ---------- */

export const ButtonStates: Story = {
  name: 'Button / IconButton · 全套交互状态',
  parameters: {
    stateMatrix: {
      components: ['Button', 'IconButton'],
      states: STATES('default', 'hover', 'press', 'focus', 'disabled', 'loading'),
      declared: STATES('hover', 'press', 'focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <Row label="变体">
        <Button variant="primary" onPress={() => undefined}>
          主按钮
        </Button>
        <Button variant="secondary" onPress={() => undefined}>
          次要
        </Button>
        <Button variant="ghost" onPress={() => undefined}>
          文字
        </Button>
        <Button variant="danger" onPress={() => undefined}>
          危险
        </Button>
      </Row>
      <Row label="尺寸">
        <Button size="sm" onPress={() => undefined}>
          sm
        </Button>
        <Button size="md" onPress={() => undefined}>
          md
        </Button>
        <Button block onPress={() => undefined}>
          占满一行
        </Button>
      </Row>
      <Row label="禁用">
        <Button variant="primary" isDisabled onPress={() => undefined}>
          主按钮
        </Button>
        <Button variant="secondary" isDisabled onPress={() => undefined}>
          次要
        </Button>
        <Button variant="ghost" isDisabled onPress={() => undefined}>
          文字
        </Button>
      </Row>
      <Row label="加载">
        <Button variant="primary" isPending onPress={() => undefined}>
          发送中
        </Button>
        <Button variant="secondary" isPending onPress={() => undefined}>
          处理中
        </Button>
      </Row>
      <Row label="图标">
        <IconButton aria-label="关闭" onPress={() => undefined}>
          <CloseGlyph />
        </IconButton>
        <IconButton aria-label="设置" variant="secondary" onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
        <IconButton aria-label="删除" variant="danger" onPress={() => undefined}>
          <CloseGlyph />
        </IconButton>
        <IconButton aria-label="加载" isPending onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
        <IconButton aria-label="禁用" isDisabled onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
      </Row>
      <p style={noteStyle}>
        悬停 / 按下 / 键盘焦点只声明，未在静态故事里复现：RAC 会在真实交互时写入
        `data-hovered` / `data-pressed` / `data-focus-visible`，外观由 `ui.css` 选择这些属性。
      </p>
    </div>
  )
}

/* ---------- 标签与键位 ---------- */

export const BadgeKbdStates: Story = {
  name: 'Badge / Kbd · 状态词与键位',
  parameters: {
    stateMatrix: {
      components: ['Badge', 'Kbd'],
      states: STATES(
        'default',
        'tone-neutral',
        'tone-accent',
        'tone-run',
        'tone-ask',
        'tone-stall',
        'tone-fail'
      ),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <Row label="色调">
        <Badge>默认</Badge>
        <Badge tone="neutral">中性</Badge>
        <Badge tone="accent">强调</Badge>
        <Badge tone="run">运行中</Badge>
        <Badge tone="ask">等你确认</Badge>
        <Badge tone="stall">停滞</Badge>
        <Badge tone="fail">失败</Badge>
      </Row>
      <Row label="键位">
        <Kbd>Ctrl</Kbd>
        <Kbd>B</Kbd>
        <span style={noteStyle}>组合键用并排的多个 Kbd 表达，不合并成一个字符串。</span>
      </Row>
    </div>
  )
}

/* ---------- 进度、骨架与转圈 ---------- */

export const ProgressSkeletonStates: Story = {
  name: 'Progress / Meter / Spinner / Skeleton · 加载状态',
  parameters: {
    stateMatrix: {
      components: ['ProgressBar', 'Meter', 'Spinner', 'Skeleton'],
      states: STATES(
        'default',
        'value-known',
        'value-unknown',
        'loading',
        'shape-text',
        'shape-rect',
        'shape-circle'
      ),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 420 }}>
      <ProgressBar label="已用上下文" value={62} showValue />
      <ProgressBar label="不确定进度" />
      <Meter label="磁盘占用" value={0.4} showValue />
      <Row label="转圈">
        <Spinner label="正在加载" />
        <Spinner size={22} label="正在同步" />
        <Spinner />
      </Row>
      <Row label="骨架">
        <div style={{ display: 'grid', gap: 'var(--s-8)', flex: 1 }}>
          <Skeleton shape="text" width="70%" />
          <Skeleton shape="text" width="45%" />
          <Skeleton shape="rect" height={56} />
          <Skeleton shape="circle" height={32} width={32} />
        </div>
      </Row>
    </div>
  )
}

/* ---------- 分隔线 ---------- */

export const SeparatorStates: Story = {
  name: 'Separator · 水平与垂直',
  parameters: {
    stateMatrix: {
      components: ['Separator'],
      states: STATES('default', 'orientation-horizontal', 'orientation-vertical'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <Separator />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-12)', height: 32 }}>
        <span>左</span>
        <Separator orientation="vertical" />
        <span>右</span>
      </div>
    </div>
  )
}

/* ---------- 集合：ListBox ---------- */

export const ListBoxStates: Story = {
  name: 'ListBox · 选中 / 焦点 / 禁用',
  parameters: {
    stateMatrix: {
      components: ['ListBox', 'ListBoxItem', 'ListBoxSection', 'Header'],
      states: STATES('default', 'selected', 'focus', 'disabled'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <ListBox
      aria-label="模型"
      selectionMode="multiple"
      defaultSelectedKeys={['fast']}
      style={{ maxWidth: 280 }}
    >
      <ListBoxSection>
        <Header>常用</Header>
        <ListBoxItem id="fast" textValue="快速">
          快速
        </ListBoxItem>
        <ListBoxItem id="balanced" textValue="均衡">
          均衡
        </ListBoxItem>
      </ListBoxSection>
      <ListBoxSection>
        <Header>全部</Header>
        <ListBoxItem id="reasoning" textValue="推理">
          推理
        </ListBoxItem>
        <ListBoxItem id="legacy" textValue="旧模型" isDisabled>
          旧模型（已下线）
        </ListBoxItem>
      </ListBoxSection>
    </ListBox>
  )
}

/* ---------- 集合：Menu ---------- */

export const MenuStates: Story = {
  name: 'Menu · 默认 / 禁用 / 子菜单 / 触发器',
  parameters: {
    stateMatrix: {
      components: ['Menu', 'MenuItem', 'MenuSection', 'MenuTrigger', 'SubmenuTrigger'],
      states: STATES('default', 'focus', 'disabled', 'open'),
      declared: STATES('focus', 'open')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <Menu aria-label="会话操作" onAction={() => undefined} style={{ maxWidth: 240 }}>
        <MenuItem>重命名</MenuItem>
        <MenuItem>在文件管理器中显示</MenuItem>
        <MenuItem isDisabled>复制会话 ID（禁用）</MenuItem>
        <MenuSection>
          <Header>更多</Header>
          <MenuItem>归档</MenuItem>
          <MenuItem>导出</MenuItem>
        </MenuSection>
      </Menu>
      <MenuTrigger>
        <Button variant="secondary" onPress={() => undefined}>
          打开菜单
        </Button>
        <Popover>
          <Menu aria-label="更多操作" onAction={() => undefined}>
            <MenuItem>置顶</MenuItem>
            <SubmenuTrigger>
              <MenuItem>移动到项目</MenuItem>
              <Popover>
                <Menu aria-label="项目" onAction={() => undefined}>
                  <MenuItem>Inkstone</MenuItem>
                  <MenuItem>pi-runtime</MenuItem>
                </Menu>
              </Popover>
            </SubmenuTrigger>
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  )
}

/* ---------- Tabs ---------- */

export const TabsStates: Story = {
  name: 'Tabs · 选中 / 焦点 / 禁用 / 可关闭',
  parameters: {
    stateMatrix: {
      components: ['Tabs', 'Tab', 'TabList', 'TabPanel', 'TabPanels'],
      states: STATES('default', 'selected', 'focus', 'disabled', 'closable'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <Tabs aria-label="视图" defaultSelectedKey="chat">
      <TabList>
        <Tab id="chat">对话</Tab>
        <Tab id="files">文件</Tab>
        <Tab id="diff" onClose={() => undefined}>
          改动
        </Tab>
        <Tab id="settings" isDisabled>
          设置
        </Tab>
      </TabList>
      <TabPanels>
        <TabPanel id="chat">对话内容</TabPanel>
        <TabPanel id="files">文件列表</TabPanel>
        <TabPanel id="diff">增删差异；右侧关闭按钮与切换是同级按钮。</TabPanel>
        <TabPanel id="settings">不可用页签不进入面板。</TabPanel>
      </TabPanels>
    </Tabs>
  )
}

/* ---------- 对话框 ---------- */

export const DialogStates: Story = {
  name: 'Dialog / Modal · 表面与触发器',
  parameters: {
    stateMatrix: {
      components: ['Dialog', 'DialogTrigger', 'Modal', 'ModalOverlay'],
      states: STATES('default', 'open', 'focus'),
      declared: STATES('open', 'focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 420 }}>
      <Dialog title="删除这个会话？" aria-label="删除会话">
        <p style={bodyStyle}>
          会话记录会从列表移除，pi 的会话文件不会被删除。这是内联渲染的表面，不经过遮罩。
        </p>
        <div style={{ display: 'flex', gap: 'var(--s-8)', justifyContent: 'flex-end', marginTop: 'var(--s-16)' }}>
          <Button variant="ghost" onPress={() => undefined}>
            取消
          </Button>
          <Button variant="danger" onPress={() => undefined}>
            删除
          </Button>
        </div>
      </Dialog>
      <DialogTrigger>
        <Button variant="secondary" onPress={() => undefined}>
          打开对话框
        </Button>
        <ModalOverlay>
          <Modal>
            <Dialog title="后台运行" aria-label="后台运行">
              <p style={bodyStyle}>遮罩、焦点圈定与 Esc 关闭由 RAC 负责；这里只声明展开状态。</p>
            </Dialog>
          </Modal>
        </ModalOverlay>
      </DialogTrigger>
      <p style={noteStyle}>对话框的「展开」状态未在静态故事里实际弹出，也未做焦点圈定实测。</p>
    </div>
  )
}

/* ---------- 浮层与提示 ---------- */

export const PopoverTooltipStates: Story = {
  name: 'Popover / Tooltip · 展开与延迟',
  parameters: {
    stateMatrix: {
      components: ['Popover', 'Tooltip', 'TooltipTrigger'],
      states: STATES('default', 'open'),
      declared: STATES('open')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <TooltipTrigger delay={0} defaultOpen>
        <Button variant="secondary" onPress={() => undefined}>
          悬停或聚焦
        </Button>
        <Tooltip>收起侧栏 Ctrl+B</Tooltip>
      </TooltipTrigger>
      <DialogTrigger>
        <Button variant="ghost" onPress={() => undefined}>
          打开浮层
        </Button>
        <Popover>
          <div style={{ padding: 'var(--s-12)', maxWidth: 240 }}>
            <Heading level={3} style={{ margin: 0, fontSize: 'var(--t-ui)' }}>
              浮层标题
            </Heading>
            <p style={{ ...bodyStyle, marginTop: 'var(--s-8)' }}>浮层内容由调用方排版。</p>
          </div>
        </Popover>
      </DialogTrigger>
    </div>
  )
}

/* ---------- 提示（Toast） ---------- */

export const ToastStates: Story = {
  name: 'Toast · 队列与色调',
  parameters: {
    stateMatrix: {
      components: ['ToastRegion', 'showToast', 'toastQueue'],
      states: STATES('default', 'tone-info', 'tone-success', 'tone-warning', 'tone-danger'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-12)' }}>
      <Row label="推送">
        <Button variant="ghost" onPress={() => showToast('已复制到剪贴板')}>
          信息
        </Button>
        <Button variant="ghost" onPress={() => showToast('已保存', { tone: 'success' })}>
          成功
        </Button>
        <Button variant="ghost" onPress={() => showToast('额度快用完了', { tone: 'warning' })}>
          警告
        </Button>
        <Button variant="ghost" onPress={() => showToast('连接失败', { tone: 'danger' })}>
          危险
        </Button>
        <Button variant="ghost" onPress={() => toastQueue.clear()}>
          清空
        </Button>
      </Row>
      <ToastRegion />
      <p style={noteStyle}>按钮只在点击时推送固定样例；故事加载本身不产生提示，也不访问宿主。</p>
    </div>
  )
}

/* ---------- 主题与密度 ---------- */

const DENSITIES = ['compact', 'standard', 'comfortable'] as const

export const ThemeDensityMatrix: Story = {
  name: '主题 × 密度 · 代表控件',
  parameters: {
    stateMatrix: {
      components: ['Heading'],
      states: STATES(
        'default',
        'theme-light',
        'theme-dark',
        'density-compact',
        'density-standard',
        'density-comfortable'
      ),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--s-16)' }}>
        {(['light', 'dark'] as const).map((mode) => (
          <section
            key={mode}
            style={{
              colorScheme: mode,
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-16)',
              display: 'grid',
              gap: 'var(--s-8)'
            }}
          >
            <Heading level={3} style={{ margin: 0, fontSize: 'var(--t-title)' }}>
              {mode === 'light' ? '浅色' : '深色'}
            </Heading>
            <Row label="标签">
              <Badge tone="run">运行中</Badge>
              <Badge tone="ask">等你确认</Badge>
            </Row>
            <Row label="键位">
              <Kbd>Ctrl</Kbd>
              <Kbd>J</Kbd>
            </Row>
            <Button variant="primary" onPress={() => undefined}>
              主按钮
            </Button>
          </section>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--s-16)' }}>
        {DENSITIES.map((name) => (
          <section
            key={name}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-12)'
            }}
          >
            <Heading level={4} style={{ margin: '0 0 var(--s-8)', fontSize: 'var(--t-meta)', color: 'var(--fg3)' }}>
              {name}
            </Heading>
            <p style={{ margin: 0, color: 'var(--fg)', fontSize: 'var(--t-body)', lineHeight: 'var(--t-body-lh)' }}>
              正文在两行内核对外壳密度。
            </p>
          </section>
        ))}
      </div>
    </div>
  )
}

/* ---------- 局部帮助件（只用于故事版面，不是产品组件） ---------- */

const noteStyle = {
  margin: 0,
  color: 'var(--fg3)',
  fontSize: 'var(--t-meta)',
  lineHeight: 'var(--t-meta-lh)'
} as const

const bodyStyle = {
  margin: 0,
  color: 'var(--fg2)',
  fontSize: 'var(--t-body)',
  lineHeight: 'var(--t-body-lh)'
} as const

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ width: 48, color: 'var(--fg3)', fontSize: 'var(--t-meta)', flex: '0 0 auto' }}>{label}</span>
      {children}
    </div>
  )
}

function CloseGlyph() {
  return (
    <svg width="var(--size-icon)" height="var(--size-icon)" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function GearGlyph() {
  return (
    <svg width="var(--size-icon)" height="var(--size-icon)" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM8 1.6l.9 1.6 1.8-.4.6 1.8 1.8.5-.4 1.8 1.3 1.3-1.3 1.3.4 1.8-1.8.5-.6 1.8-1.8-.4L8 14.4l-.9-1.6-1.8.4-.6-1.8-1.8-.5.4-1.8L2 7.8l1.3-1.3-.4-1.8 1.8-.5.6-1.8 1.8.4L8 1.6z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  )
}
