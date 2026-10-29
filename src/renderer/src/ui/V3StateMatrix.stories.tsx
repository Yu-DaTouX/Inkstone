import { useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Avatar,
  avatarInitial,
  Badge,
  Button,
  Card,
  CardActions,
  CardBody,
  CardChevron,
  CardControl,
  CardHead,
  CardMeta,
  CardStatus,
  CardSummary,
  CardTime,
  CardTitle,
  CloseButton,
  Collapsible,
  CollapsibleChevron,
  CollapsibleHeader,
  CollapsiblePanel,
  CommandSurface,
  CommandSurfaceBody,
  CommandSurfaceFooter,
  CommandSurfaceHeader,
  CommandSurfacePanel,
  ConfirmDialog,
  DialogFooter,
  DiffStat,
  FindBar,
  InlineRename,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  KbdGroup,
  ListRow,
  ListRowStatic,
  TooltipText,
  isImeComposing,
  CONTROL_ICON_SIZE,
  MenuSeparator,
  MiddleTruncate,
  QrCode,
  Toggle,
  ToggleGroup,
  TreeRow,
  EmptyState,
  Notice,
  PageHeader,
  PaneHeader,
  CompletionSweep,
  Dialog,
  DialogTrigger,
  FileCard,
  Focusable,
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
  MeterRing,
  MiniBars,
  Modal,
  ModalOverlay,
  Popover,
  ProgressBar,
  RailRow,
  RailValue,
  SegmentBar,
  Separator,
  SettingRow,
  SettingRows,
  SettingSection,
  SettingsDialog,
  SettingsNav,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsSearch,
  SettingsSearchMatch,
  SettingsTab,
  SettingsTabBar,
  ShimmerText,
  showToast,
  Skeleton,
  Spinner,
  Stat,
  StatGrid,
  StatusDot,
  StatusSlot,
  SubmenuTrigger,
  Swatch,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  ToastRegion,
  toastQueue,
  Tooltip,
  TooltipHint,
  TooltipTrigger
} from './index'

const meta = {
  title: 'v3/状态矩阵',
  parameters: { layout: 'padded' }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const STATES = (...names: string[]) => names

export const ButtonStates: Story = {
  name: 'Button / IconButton · 全套交互状态',
  parameters: {
    stateMatrix: {
      components: ['Button', 'IconButton'],
      states: STATES('default', 'hover', 'press', 'focus', 'disabled', 'loading', 'selected'),
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
      <Row label="开关">
        <IconButton aria-label="强调按下" aria-pressed onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
        <IconButton aria-label="中性按下" pressedTone="neutral" aria-pressed onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
        <IconButton aria-label="中性未按下" pressedTone="neutral" aria-pressed={false} onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
        <IconButton aria-label="描边按下" pressedTone="outline" aria-pressed onPress={() => undefined}>
          <GearGlyph />
        </IconButton>
        <IconButton aria-label="描边部分" pressedTone="outline" aria-pressed data-active="partial" onPress={() => undefined}>
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

export const BadgeKbdStates: Story = {
  name: 'Badge / Kbd · 状态词与键位',
  parameters: {
    stateMatrix: {
      components: ['Badge', 'Kbd'],
      states: STATES(
        'default',
        'tone-neutral',
        'tone-accent',
        'tone-ok',
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
        <Badge tone="ok">已完成</Badge>
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

export const NoticeEmptyStates: Story = {
  name: 'Notice / EmptyState · 提示与空态',
  parameters: {
    stateMatrix: {
      components: ['Notice', 'EmptyState'],
      states: STATES('default', 'tone-info', 'tone-ok', 'tone-ask', 'tone-stall', 'tone-fail', 'empty'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-12)', maxWidth: 520 }}>
      <Notice>默认提示：用于中性说明。</Notice>
      <Notice tone="info" title="说明">信息提示带标题。</Notice>
      <Notice tone="ok">已保存。</Notice>
      <Notice tone="ask" action={<Button size="sm" variant="secondary">去处理</Button>}>需要你确认后才会继续。</Notice>
      <Notice tone="stall" compact>已经很久没有新输出。</Notice>
      <Notice tone="fail" title="连接失败">pi 进程已退出。</Notice>
      <EmptyState title="还没有内容" description="空态用一句话说明原因，并给出下一步。" action={<Button size="sm">新建</Button>} />
      <EmptyState size="sm" title="没有匹配项" />
    </div>
  )
}

export const HeaderCardStates: Story = {
  name: 'PageHeader / PaneHeader / Card · 结构',
  parameters: {
    stateMatrix: {
      components: ['PageHeader', 'PaneHeader', 'Card'],
      states: STATES('default', 'hover'),
      declared: ['hover']
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 560 }}>
      <PageHeader title="运行" description="页面标题默认是 h2，顶栏保留唯一 h1。" actions={<Button size="sm">刷新</Button>} />
      <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
        <PaneHeader title="改动" meta="3 个文件" actions={<IconButton aria-label="关闭">×</IconButton>} />
        <PaneHeader size="sm" title="终端" />
      </div>
      <Card>默认卡片</Card>
      <Card interactive padding="sm">可交互卡片：悬停时边框加深。</Card>
    </div>
  )
}

const CARD_DEMO_AT = Date.UTC(2026, 9, 27, 8, 30)

function CardGrammarDemo(): ReactNode {
  const [expanded, setExpanded] = useState(true)
  return (
    <div style={{ display: 'grid', gap: 'var(--s-12)', maxWidth: 480 }}>
      <Card padding="none">
        <CardSummary expanded={expanded} onPress={() => setExpanded(!expanded)}>
          <CardStatus tone="accent">提问</CardStatus>
          <CardTitle clamp>要先运行哪一组测试？</CardTitle>
          <CardMeta>剩余 2 分钟</CardMeta>
        </CardSummary>
        {expanded ? (
          <>
            <CardBody>展开后显示正文；折叠只收起内容，不表示关闭。</CardBody>
            <CardActions lead={<Button size="sm" variant="ghost">跳过</Button>}>
              <Button size="sm" variant="primary">提交</Button>
            </CardActions>
          </>
        ) : null}
      </Card>
      <Card padding="none" tone="ask">
        <CardHead>
          <CardStatus tone="ask">等待审批</CardStatus>
          <CardTitle>Agent 想写入项目外的文件</CardTitle>
          <CardMeta>已等 12 秒</CardMeta>
          <CardControl><IconButton size="sm" variant="plain" aria-label="收起"><CardChevron /></IconButton></CardControl>
        </CardHead>
      </Card>
      <Card padding="none" receipt>
        <CardHead>
          <CardStatus tone="ok">已允许一次</CardStatus>
          <CardTitle>Agent 想执行一个难以撤销的操作</CardTitle>
          <CardMeta><CardTime at={CARD_DEMO_AT} /></CardMeta>
        </CardHead>
      </Card>
      <Card padding="none" receipt>
        <CardHead>
          <CardStatus tone="run">运行中</CardStatus>
          <CardTitle>子 Agent · 整理测试</CardTitle>
          <CardMeta>1 分 20 秒</CardMeta>
        </CardHead>
      </Card>
      <Card padding="none" tone="fail">
        <CardHead>
          <CardStatus tone="fail">失败</CardStatus>
          <CardTitle>pi 进程已退出</CardTitle>
        </CardHead>
        <CardBody>阻塞错误保持醒目，主操作放在右侧。</CardBody>
        <CardActions>
          <Button size="sm">重试</Button>
        </CardActions>
      </Card>
    </div>
  )
}

export const CardGrammarStates: Story = {
  name: 'Card · 头部语法与回执',
  parameters: {
    stateMatrix: {
      components: ['Card', 'CardHead', 'CardSummary', 'CardStatus', 'CardTitle', 'CardMeta', 'CardControl', 'CardBody', 'CardActions', 'CardChevron', 'CardTime'],
      states: STATES('default', 'open', 'tone-accent', 'tone-run', 'tone-ask', 'tone-ok', 'tone-fail')
    }
  },
  render: () => <CardGrammarDemo />
}

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

export const StatStates: Story = {
  name: 'Stat / StatGrid / MeterRing / MiniBars · 指标格',
  parameters: {
    stateMatrix: {
      components: ['Stat', 'StatGrid', 'MeterRing', 'MiniBars', 'SegmentBar', 'Swatch'],
      states: STATES('default', 'value-known'),
      declared: []
    }
  },
  render: () => (
    <div style={{ maxWidth: 280 }}>
      <StatGrid>
        <Stat label="轮数" value="12" />
        <Stat label="步数" value="48" />
        <Stat label="总数" value="1.2M" unit="tok" />
        <Stat label="累计命中率" value="82.4%" aside={<MeterRing aria-label="累计命中率" value={82.4} />} />
        <Stat label="输出速度" value="64.2" unit="tok/s" span={2} aside={<MiniBars values={[40, 52, 61, 45, 70, 58, 66, 64]} />} />
      </StatGrid>
      <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
        <SegmentBar
          aria-label="Token 构成"
          segments={[
            { key: 'input', value: 12, tone: 1 },
            { key: 'cacheRead', value: 600, tone: 2 },
            { key: 'cacheWrite', value: 40, tone: 3 },
            { key: 'output', value: 55, tone: 6 }
          ]}
        />
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Swatch tone={2} /> 缓存读取
        </span>
        <MiniBars values={[40, 52, 61, 45, 70]} pending={30} slots={12} stretch />
      </div>
    </div>
  )
}

export const RailStates: Story = {
  name: 'RailValue / RailRow · 会话栏磁贴',
  parameters: {
    stateMatrix: {
      components: ['RailValue', 'RailRow'],
      states: STATES('default', 'value-known', 'value-unknown', 'tone-ok', 'tone-ask', 'tone-fail', 'disabled'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-12)', maxWidth: 280 }}>
      <Row label="收起摘要">
        <RailValue glyph={{ kind: 'ring', percent: 45, label: '上下文' }} value="45%" digits={4} />
        <RailValue glyph={{ kind: 'ring', percent: null, label: '上下文' }} value="—" />
        <RailValue glyph={{ kind: 'ring', percent: 92, label: '用量' }} tone="ask" value="5h 92%" />
        <RailValue glyph={{ kind: 'segments', done: 2, total: 3 }} value="2 / 3" />
        <RailValue glyph={{ kind: 'segments', done: 3, total: 3 }} tone="ok" value="3 / 3" />
        <RailValue glyph={{ kind: 'dot', status: 'running' }} value="2 运行中" />
        <RailValue glyph={{ kind: 'dot', status: 'fail' }} error value="读取失败" />
        <RailValue glyph={{ kind: 'delta', added: 128, removed: 12 }} />
      </Row>
      <Row label="组合">
        <span style={{ display: 'inline-flex', gap: 'var(--s-4)' }}>
          <RailValue glyph={{ kind: 'ring', percent: 82, label: '缓存命中' }} value="82%" />
          <RailValue joined value="42.3" unit="tok/s" digits={4} glyph={{ kind: 'bars', values: [30, 44, 40], pending: 38, slots: 4 }} glyphEnd />
        </span>
      </Row>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        <RailRow label="inkstone" icon={<StatusDot kind="idle" />} value="pi-desktop" onPress={() => undefined} />
        <RailRow label="filesystem" dot="ok" value="12 个工具" />
        <RailRow label="github" dot="fail" value="出错" error />
        <RailRow label="report-final-version-with-a-very-long-name.md" value="docs" isDisabled onPress={() => undefined} />
        <RailRow label="index.ts" value={<RailValue glyph={{ kind: 'delta', added: 3, removed: 1 }} />} action={<Button size="sm" variant="ghost">×</Button>} />
      </ul>
    </div>
  )
}

export const ShimmerStates: Story = {
  name: 'ShimmerText / CompletionSweep · 运行与收尾',
  parameters: {
    stateMatrix: {
      components: ['ShimmerText', 'CompletionSweep'],
      states: STATES('default', 'loading', 'tone-success'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 420 }}>
      <Row label="流光">
        <ShimmerText>正在思考</ShimmerText>
        <ShimmerText lead={<span>$ </span>}>npm run build</ShimmerText>
        <ShimmerText active={false}>已完成</ShimmerText>
      </Row>
      <Row label="收尾">
        <span style={{ position: 'relative', display: 'block', flex: 1, padding: 'var(--s-6) var(--s-8)', borderRadius: 'var(--r-sm)' }}>
          <CompletionSweep done />
          读取 package.json
        </span>
      </Row>
    </div>
  )
}

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
        <Tab id="chat">会话</Tab>
        <Tab id="files">文件</Tab>
        <Tab id="diff" onClose={() => undefined}>
          改动
        </Tab>
        <Tab id="settings" isDisabled>
          设置
        </Tab>
      </TabList>
      <TabPanels>
        <TabPanel id="chat">会话内容</TabPanel>
        <TabPanel id="files">文件列表</TabPanel>
        <TabPanel id="diff">增删差异；右侧关闭按钮与切换是同级按钮。</TabPanel>
        <TabPanel id="settings">不可用页签不进入面板。</TabPanel>
      </TabPanels>
    </Tabs>
  )
}

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

export const PopoverTooltipStates: Story = {
  name: 'Popover / Tooltip · 展开与延迟',
  parameters: {
    stateMatrix: {
      components: ['Popover', 'Tooltip', 'TooltipHint', 'TooltipTrigger', 'Focusable'],
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
      <TooltipTrigger delay={0}>
        <Button variant="secondary" onPress={() => undefined}>
          带快捷键与说明
        </Button>
        <Tooltip>
          <TooltipHint label="收起侧栏" shortcut="Ctrl+B" detail="再按一次展开" />
        </Tooltip>
      </TooltipTrigger>
      <TooltipTrigger delay={0}>
        <Focusable>
          <span tabIndex={0} style={noteStyle}>
            非按钮元素：用 Focusable 包裹后也能承载提示
          </span>
        </Focusable>
        <Tooltip>说明文字</Tooltip>
      </TooltipTrigger>
      <DialogTrigger>
        <Button variant="ghost" onPress={() => undefined}>
          打开浮层
        </Button>
        <Popover>
          <div style={{ padding: 'var(--s-12)', maxWidth: 240 }}>
            <Heading level={3} style={{ margin: 0, fontSize: 'var(--t-body)' }}>
              浮层标题
            </Heading>
            <p style={{ ...bodyStyle, marginTop: 'var(--s-8)' }}>浮层内容由调用方排版。</p>
          </div>
        </Popover>
      </DialogTrigger>
    </div>
  )
}

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

export const FileCardStates: Story = {
  name: 'FileCard · 文件与目录卡片',
  parameters: {
    stateMatrix: {
      components: ['FileCard'],
      states: STATES('default', 'disabled', 'density-compact', 'density-comfortable'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <Row label="标准">
        <FileCard name="README.md" path="E:/project/README.md" onPress={() => undefined} />
        <FileCard name="src" path="E:/project/src" isDirectory onPress={() => undefined} />
        <FileCard name="不可用.md" isDisabled onPress={() => undefined} />
      </Row>
      <Row label="紧凑">
        <FileCard compact name="README.md" path="E:/project/README.md" onPress={() => undefined} />
        <FileCard compact name="src" path="E:/project/src" isDirectory onPress={() => undefined} />
        <FileCard compact name="不可用.md" isDisabled onPress={() => undefined} />
      </Row>
    </div>
  )
}

export const StatusAvatarStates: Story = {
  name: 'StatusDot / StatusSlot / Avatar · 状态点与头像',
  parameters: {
    stateMatrix: {
      components: ['StatusDot', 'StatusSlot', 'Avatar', 'avatarInitial'],
      states: STATES('default', 'tone-neutral', 'tone-fail'),
      declared: []
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <Row label="状态点">
        {(['running', 'awaiting', 'ready', 'idle', 'ok', 'pending', 'fail'] as const).map((kind) => (
          <span key={kind} style={{ display: 'inline-flex', gap: 'var(--s-4)', alignItems: 'center' }}>
            <StatusDot kind={kind} />
            <span style={noteStyle}>{kind}</span>
          </span>
        ))}
      </Row>
      <Row label="槽位">
        <StatusSlot label="运行中" live>
          <StatusDot kind="running" />
        </StatusSlot>
        <StatusSlot tone="muted" label="空闲">
          <StatusDot kind="idle" />
        </StatusSlot>
        <StatusSlot tone="danger" label="失败">
          <StatusDot kind="fail" />
        </StatusSlot>
      </Row>
      <Row label="头像">
        <Avatar name="砚" />
        <Avatar name="inkstone" />
        <Avatar name="  yan" />
        <span style={noteStyle}>首字取大写：{avatarInitial('inkstone')}；空名字不显示字符。</span>
        <Avatar name="" />
      </Row>
    </div>
  )
}

export const SettingsStates: Story = {
  name: 'SettingsDialog / SettingRow · 设置对话框与行',
  parameters: {
    stateMatrix: {
      components: [
        'SettingRow',
        'SettingRows',
        'SettingSection',
        'SettingsDialog',
        'SettingsNav',
        'SettingsNavGroup',
        'SettingsNavItem',
        'SettingsSearch',
        'SettingsSearchMatch',
        'SettingsTab',
        'SettingsTabBar'
      ],
      states: STATES('default', 'hover', 'focus', 'open', 'selected', 'empty', 'disabled'),
      declared: STATES('open', 'hover', 'focus')
    }
  },
  render: function SettingsStatesStory() {
    const [open, setOpen] = useState(false)
    const [current, setCurrent] = useState('general')
    const [query, setQuery] = useState('')
    const items = [
      { id: 'general', label: '通用' },
      { id: 'models', label: '模型' },
      { id: 'about', label: '关于' }
    ]
    const results = items
      .filter((item) => query.trim() !== '' && item.label.includes(query.trim()))
      .map((item) => ({ key: item.id, kind: 'hit' as const, primary: item.label, secondary: '示例设置项', label: item.label }))
    const nav = (
      <SettingsNav
        label="设置分区"
        search={
          <SettingsSearch
            value={query}
            onChange={setQuery}
            results={results}
            onSelect={(result) => setCurrent(result.key)}
            label="搜索设置"
            placeholder="搜索"
            resultsLabel="设置搜索结果"
            emptyLabel="没有匹配的设置"
          />
        }
      >
        <SettingsNavGroup title="应用">
          {items.map((item) => (
            <SettingsNavItem
              key={item.id}
              label={item.label}
              current={current === item.id}
              onPress={() => setCurrent(item.id)}
            />
          ))}
        </SettingsNavGroup>
      </SettingsNav>
    )
    const tabs = (
      <SettingsTabBar label="设置分区">
        {items.map((item) => (
          <SettingsTab key={item.id} label={item.label} selected={current === item.id} onPress={() => setCurrent(item.id)} />
        ))}
      </SettingsTabBar>
    )
    return (
      <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 560 }} data-density-scope="comfortable">
        <SettingSection title="外观" description="分组标题与说明">
          <SettingRow label="语言" description="界面显示语言">
            <Button variant="secondary" onPress={() => undefined}>
              简体中文
            </Button>
          </SettingRow>
          <SettingRow label="缩进项" indent description="从属于上一项">
            <Button variant="ghost" onPress={() => undefined}>
              调整
            </Button>
          </SettingRow>
          <SettingRow block label="整块内容" description="控件独占一行">
            <div style={bodyStyle}>块级控件区域</div>
          </SettingRow>
          <SettingRow label="只有文字" />
        </SettingSection>
        <SettingRows label="无标题分组">
          <SettingRow label="停用的搜索框" description="禁用态">
            <div style={{ width: 200 }}>
              <SettingsSearch
                value=""
                onChange={() => undefined}
                results={[]}
                onSelect={() => undefined}
                label="停用的搜索"
                resultsLabel="结果"
                emptyLabel="没有匹配的设置"
                isDisabled
              />
            </div>
          </SettingRow>
          <SettingRow label="匹配高亮" description={<SettingsSearchMatch text="代码主题" query="主题" />} />
        </SettingRows>
        <div style={{ display: 'flex', gap: 'var(--s-16)' }}>
          <div style={{ width: 220 }}>{nav}</div>
          <div style={{ minWidth: 0, flex: 1 }}>{tabs}</div>
        </div>
        <Button variant="secondary" onPress={() => setOpen(true)}>
          打开设置对话框
        </Button>
        <SettingsDialog isOpen={open} onOpenChange={setOpen} title="设置" closeLabel="关闭" nav={nav} narrowNav={tabs}>
          <SettingSection title={current}>
            <SettingRow label="当前分区" description="对话框内容区" />
          </SettingSection>
        </SettingsDialog>
        <p style={noteStyle}>
          设置对话框的「展开」、搜索结果浮层的悬停与焦点需要实际交互，静态矩阵只声明；输入「通用」可看到结果，输入其它文字看到空结果。
        </p>
      </div>
    )
  }
}

const DENSITIES = ['compact', 'comfortable'] as const

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
            <Heading level={3} style={{ margin: 0, fontSize: 'var(--t-heading)' }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--s-16)' }}>
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
            <Heading level={4} style={{ margin: '0 0 var(--s-8)', fontSize: 'var(--t-footnote)', color: 'var(--fg3)' }}>
              {name}
            </Heading>
            <p style={{ margin: 0, color: 'var(--fg)', fontSize: 'var(--t-prose)', lineHeight: 'var(--t-prose-lh)' }}>
              正文在两行内核对外壳密度。
            </p>
          </section>
        ))}
      </div>
    </div>
  )
}

const noteStyle = {
  margin: 0,
  color: 'var(--fg3)',
  fontSize: 'var(--t-footnote)',
  lineHeight: 'var(--t-footnote-lh)'
} as const

const bodyStyle = {
  margin: 0,
  color: 'var(--fg2)',
  fontSize: 'var(--t-prose)',
  lineHeight: 'var(--t-prose-lh)'
} as const

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ width: 48, color: 'var(--fg3)', fontSize: 'var(--t-footnote)', flex: '0 0 auto' }}>{label}</span>
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

function ThemePair({ children, columns = 2 }: { children: () => ReactNode; columns?: 1 | 2 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 'var(--s-16)' }}>
      {(['light', 'dark'] as const).map((mode) => (
        <section
          key={mode}
          data-theme-sample={mode}
          style={{
            colorScheme: mode,
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-16)',
            display: 'grid',
            gap: 'var(--s-12)',
            alignContent: 'start',
            minWidth: 0
          }}
        >
          <span style={noteStyle}>{mode === 'light' ? '浅色' : '深色'}</span>
          {children()}
        </section>
      ))}
    </div>
  )
}

function FindBarDemo({ initial = '', count = 12, disabled = false }: { initial?: string; count?: number; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  const [index, setIndex] = useState(0)
  const [options, setOptions] = useState({ case: false, word: true, regex: false })
  const total = value ? count : null
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', opacity: disabled ? 0.4 : 1 }}>
      <FindBar
        value={value}
        onChange={setValue}
        autoFocus={false}
        matchIndex={index}
        matchCount={total}
        onNext={() => setIndex((i) => (total ? (i + 1) % total : 0))}
        onPrevious={() => setIndex((i) => (total ? (i - 1 + total) % total : 0))}
        onClose={() => setValue('')}
        options={[
          { id: 'case', label: '区分大小写', icon: <TextGlyph text="Aa" />, selected: options.case },
          { id: 'word', label: '全词匹配', icon: <TextGlyph text="ab" />, selected: options.word },
          { id: 'regex', label: '正则表达式', icon: <TextGlyph text=".*" />, selected: options.regex }
        ]}
        onOptionChange={(id, selected) => setOptions((prev) => ({ ...prev, [id]: selected }))}
      />
    </div>
  )
}

export const InputGroupFindBarStates: Story = {
  name: 'InputGroup / FindBar · 前缀、附加、计数与匹配选项',
  parameters: {
    stateMatrix: {
      components: ['InputGroup', 'InputGroupAddon', 'InputGroupInput', 'InputGroupText', 'FindBar'],
      states: STATES('default', 'focus', 'disabled', 'invalid', 'empty', 'selected'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <InputGroup aria-label="过滤文件">
            <InputGroupAddon align="start">
              <SearchGlyph />
            </InputGroupAddon>
            <InputGroupInput aria-label="过滤文件" placeholder="过滤文件…" />
            <InputGroupAddon align="end">
              <KbdGroup keys={['Ctrl', 'P']} />
            </InputGroupAddon>
          </InputGroup>
          <InputGroup size="sm" aria-label="分支名">
            <InputGroupInput aria-label="分支名" defaultValue="feature/inkstone-ui-batch0" />
            <InputGroupAddon align="end">
              <InputGroupText>3/12</InputGroupText>
              <IconButton size="xs" aria-label="清除" tooltip="清除">
                <CloseGlyph />
              </IconButton>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup variant="ghost" aria-label="幽灵输入">
            <InputGroupAddon align="start">
              <SearchGlyph />
            </InputGroupAddon>
            <InputGroupInput aria-label="幽灵输入" placeholder="幽灵变体：悬停才显底色" />
          </InputGroup>
          <InputGroup isInvalid aria-label="错误">
            <InputGroupInput aria-label="错误" defaultValue="无效的路径" />
          </InputGroup>
          <InputGroup isDisabled aria-label="禁用">
            <InputGroupInput aria-label="禁用" placeholder="禁用" disabled />
          </InputGroup>
          <FindBarDemo initial="render" />
          <FindBarDemo initial="不存在的词" count={0} />
          <FindBarDemo />
        </>
      )}
    </ThemePair>
  )
}

function ConfirmDemo({ tone, label }: { tone: 'default' | 'danger'; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant={tone === 'danger' ? 'danger' : 'secondary'} onPress={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={setOpen}
        tone={tone}
        title={tone === 'danger' ? '删除这个会话？' : '重新连接设备？'}
        description={tone === 'danger' ? '会话记录会从列表移除，pi 的会话文件不会被删除。' : '当前连接会断开，未发送的输入会保留。'}
        confirmLabel={tone === 'danger' ? '删除' : '重新连接'}
        confirmTestId={`confirm-${tone}`}
        cancelTestId={`cancel-${tone}`}
        data-testid={`dialog-${tone}`}
        onConfirm={() => new Promise((resolve) => setTimeout(resolve, 600))}
      />
    </>
  )
}

export const DialogFooterConfirmStates: Story = {
  name: 'DialogFooter / ConfirmDialog · 按钮区与危险确认',
  parameters: {
    stateMatrix: {
      components: ['DialogFooter', 'ConfirmDialog'],
      states: STATES('default', 'open', 'loading', 'tone-danger'),
      declared: STATES('open', 'loading')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface-3)', boxShadow: 'var(--shadow-lg)' }}>
            <Dialog alert title="删除这个会话？" aria-label="删除会话">
              <p style={bodyStyle}>bare 按钮区：只排列按钮，不加底色。</p>
              <DialogFooter>
                <Button variant="ghost">取消</Button>
                <Button variant="destructive">删除</Button>
              </DialogFooter>
            </Dialog>
          </div>
          <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--surface-3)', boxShadow: 'var(--shadow-lg)' }}>
            <Dialog title="导出会话" aria-label="导出会话">
              <p style={bodyStyle}>bar 按钮区：贴底、顶部分隔线与下沉底色（T3 默认）。</p>
              <DialogFooter variant="bar" align="between">
                <Button variant="ghost" size="sm">
                  高级选项
                </Button>
                <span style={{ display: 'flex', gap: 'var(--s-8)' }}>
                  <Button variant="ghost">取消</Button>
                  <Button variant="primary">导出</Button>
                </span>
              </DialogFooter>
            </Dialog>
          </div>
          <Row label="确认">
            <ConfirmDemo tone="danger" label="危险确认" />
            <ConfirmDemo tone="default" label="普通确认" />
          </Row>
        </>
      )}
    </ThemePair>
  )
}

export const ConfirmDialogOpen: Story = {
  name: 'ConfirmDialog · 展开（危险）',
  parameters: {
    stateMatrix: {
      components: ['ConfirmDialog'],
      states: STATES('open', 'tone-danger'),
      declared: []
    }
  },
  render: () => <ConfirmOpenDemo />
}

function ConfirmOpenDemo() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Button onPress={() => setOpen(true)}>重新打开</Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={setOpen}
        tone="danger"
        title="删除 3 个本地分支？"
        description="已合并的分支会被删除，远端分支不受影响。此操作不能撤销。"
        confirmLabel="删除分支"
        onConfirm={() => undefined}
      >
        <Notice tone="ask" compact>
          feature/old-ui 还有未推送的提交。
        </Notice>
      </ConfirmDialog>
    </>
  )
}

export const MenuSlotStates: Story = {
  name: 'Menu · 图标 / 说明 / 勾选 / 快捷键 / 分隔线',
  parameters: {
    stateMatrix: {
      components: ['Menu', 'MenuItem', 'MenuSeparator'],
      states: STATES('default', 'selected', 'disabled', 'tone-danger'),
      declared: []
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <div className="ui-popover" style={{ position: 'static', maxWidth: 300 }}>
          <Menu aria-label="附加" onAction={() => undefined}>
            <MenuItem icon={<GearGlyph />} description="png、jpg、webp，最多 10 张" shortcut="Ctrl+U">
              添加图片
            </MenuItem>
            <MenuItem icon={<SearchGlyph />} shortcut="Ctrl+F">
              在会话中查找
            </MenuItem>
            <MenuSeparator />
            <MenuItem checked description="写入文件前不再询问">
              自动批准
            </MenuItem>
            <MenuItem checked={false} description="可以读写项目外的路径">
              不受限制
            </MenuItem>
            <MenuItem isDisabled icon={<GearGlyph />}>
              禁用项
            </MenuItem>
            <MenuSeparator />
            <MenuItem tone="danger" icon={<CloseGlyph />}>
              删除会话
            </MenuItem>
          </Menu>
        </div>
      )}
    </ThemePair>
  )
}

export const ToggleStates: Story = {
  name: 'Toggle / ToggleGroup · 图标开关与分组',
  parameters: {
    stateMatrix: {
      components: ['Toggle', 'ToggleGroup'],
      states: STATES('default', 'selected', 'disabled', 'focus', 'hover'),
      declared: STATES('focus', 'hover')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <Row label="单个">
            <Toggle icon size="xs" aria-label="区分大小写" tooltip="区分大小写">
              <TextGlyph text="Aa" />
            </Toggle>
            <Toggle icon size="xs" aria-label="全词" defaultSelected tooltip="全词匹配">
              <TextGlyph text="ab" />
            </Toggle>
            <Toggle icon size="sm" aria-label="设置" defaultSelected>
              <GearGlyph />
            </Toggle>
            <Toggle size="sm" variant="outline" defaultSelected>
              换行
            </Toggle>
            <Toggle size="sm" isDisabled>
              禁用
            </Toggle>
          </Row>
          <Row label="多选">
            <ToggleGroup aria-label="匹配选项" selectionMode="multiple" defaultSelectedKeys={['word']} size="xs">
              <Toggle id="case" icon aria-label="区分大小写">
                <TextGlyph text="Aa" />
              </Toggle>
              <Toggle id="word" icon aria-label="全词">
                <TextGlyph text="ab" />
              </Toggle>
              <Toggle id="regex" icon aria-label="正则">
                <TextGlyph text=".*" />
              </Toggle>
            </ToggleGroup>
          </Row>
          <Row label="分段">
            <ToggleGroup aria-label="视图" variant="segmented" selectionMode="single" disallowEmptySelection defaultSelectedKeys={['split']}>
              <Toggle id="unified">合并</Toggle>
              <Toggle id="split">并排</Toggle>
              <Toggle id="raw">原文</Toggle>
            </ToggleGroup>
          </Row>
        </>
      )}
    </ThemePair>
  )
}

export const CollapsibleStates: Story = {
  name: 'Collapsible / CollapsibleHeader · 统一箭头',
  parameters: {
    stateMatrix: {
      components: ['Collapsible', 'CollapsibleHeader', 'CollapsiblePanel', 'CollapsibleChevron'],
      states: STATES('default', 'open'),
      declared: []
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <Collapsible defaultExpanded>
            <CollapsibleHeader accessory={<DiffStat added={42} removed={7} />} actions={<IconButton size="xs" aria-label="刷新" tooltip="刷新"><GearGlyph /></IconButton>}>
              已暂存
            </CollapsibleHeader>
            <CollapsiblePanel>
              <p style={{ ...noteStyle, padding: '0 var(--s-8) var(--s-8) var(--s-24)' }}>展开时箭头向下（ChevronRight 旋转 90°）。</p>
            </CollapsiblePanel>
          </Collapsible>
          <Collapsible>
            <CollapsibleHeader accessory="12">未暂存</CollapsibleHeader>
            <CollapsiblePanel>
              <p style={noteStyle}>收起内容</p>
            </CollapsiblePanel>
          </Collapsible>
          <Collapsible defaultExpanded>
            <CollapsibleHeader chevron="end" rule tone="emphasized">
              T3 小节标题（尾部箭头 + 分隔线）
            </CollapsibleHeader>
            <CollapsiblePanel>
              <p style={{ ...noteStyle, padding: '0 var(--s-8) var(--s-8)' }}>同一套箭头大小与旋转方向。</p>
            </CollapsiblePanel>
          </Collapsible>
          <Row label="箭头">
            <CollapsibleChevron expanded={false} />
            <CollapsibleChevron expanded />
          </Row>
        </div>
      )}
    </ThemePair>
  )
}

function RenameDemo({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  const [editing, setEditing] = useState(true)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-8)', height: 'var(--d-row)', minWidth: 0 }}>
      {editing ? (
        <InlineRename
          aria-label="重命名"
          defaultValue={value}
          select="stem"
          autoFocus={false}
          onCommit={(next) => {
            setValue(next)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Button variant="ghost" size="sm" onPress={() => setEditing(true)}>
          {value}
        </Button>
      )}
    </div>
  )
}

export const TextUtilityStates: Story = {
  name: 'MiddleTruncate / DiffStat / InlineRename / QrCode',
  parameters: {
    stateMatrix: {
      components: ['MiddleTruncate', 'DiffStat', 'InlineRename', 'QrCode'],
      states: STATES('default', 'empty', 'focus'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <div style={{ display: 'grid', gap: 'var(--s-4)', width: 220, fontSize: 'var(--t-body)' }}>
            <MiddleTruncate value="src/renderer/src/features/changes/ChangesPane.tsx" />
            <MiddleTruncate value="E:/pi-desktop/.local-docs/evidence/2026-10-29-c-route/ui-inventory.md" />
            <MiddleTruncate value="short.ts" />
          </div>
          <Row label="行数">
            <DiffStat added={128} removed={34} />
            <DiffStat added={3} removed={0} hideZero />
            <DiffStat added={0} removed={9} size="md" />
          </Row>
          <RenameDemo initial="设计稿-最终版.fig" />
          <QrCode value="https://github.com/Yu-DaTouX/Inkstone" size={112} title="邀请链接二维码" />
        </>
      )}
    </ThemePair>
  )
}

export const RowComponentStates: Story = {
  name: 'ListRow / TreeRow · 行组件与缩进令牌',
  parameters: {
    stateMatrix: {
      components: ['ListRow', 'TreeRow'],
      states: STATES('default', 'selected', 'disabled', 'hover'),
      declared: STATES('hover')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <div style={{ display: 'grid', gap: 'var(--s-12)', maxWidth: 280 }}>
          <div style={{ display: 'grid', gap: 1 }}>
            <ListRow icon={<GearGlyph />} trailing="3 分钟">
              重构设置页
            </ListRow>
            <ListRow icon={<GearGlyph />} current trailing={<Badge tone="run">运行中</Badge>}>
              UI 第 0 批
            </ListRow>
            <ListRow icon={<GearGlyph />} muted>
              已归档会话
            </ListRow>
            <ListRow variant="field" icon={<SearchGlyph />}>
              搜索会话
            </ListRow>
          </div>
          <div role="tree" aria-label="改动文件" style={{ display: 'grid', gap: 1 }}>
            <TreeRow role="treeitem" depth={0} expanded icon={<FolderGlyph />}>
              src
            </TreeRow>
            <TreeRow role="treeitem" depth={1} expanded icon={<FolderGlyph />}>
              renderer
            </TreeRow>
            <TreeRow role="treeitem" depth={2} icon={<FileGlyph />} trailing={<DiffStat added={12} removed={3} />} current>
              Button.tsx
            </TreeRow>
            <TreeRow role="treeitem" depth={2} icon={<FileGlyph />} trailing={<DiffStat added={4} removed={0} hideZero />}>
              tokens.json
            </TreeRow>
            <TreeRow role="treeitem" depth={1} expanded={false} icon={<FolderGlyph />}>
              main
            </TreeRow>
          </div>
        </div>
      )}
    </ThemePair>
  )
}

export const CompactControlStates: Story = {
  name: 'Button xs/micro · IconButton tooltip · CloseButton · Kbd · Spinner 档位',
  parameters: {
    stateMatrix: {
      components: ['Button', 'IconButton', 'CloseButton', 'Kbd', 'KbdGroup', 'Spinner', 'Badge'],
      states: STATES('default', 'disabled', 'loading', 'open', 'tone-danger'),
      declared: STATES('open')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <Row label="尺寸">
            <Button size="md">md 24</Button>
            <Button size="sm">sm 20</Button>
            <Button size="xs" icon={<GearGlyph />}>
              xs 20
            </Button>
            <Button size="micro">micro 16</Button>
            <Button size="xs" variant="ghost">
              ghost xs
            </Button>
          </Row>
          <Row label="图标">
            <IconButton size="md" aria-label="设置" tooltip="设置" tooltipShortcut="Ctrl+,">
              <GearGlyph />
            </IconButton>
            <IconButton size="sm" aria-label="设置 sm" tooltip="设置">
              <GearGlyph />
            </IconButton>
            <IconButton size="xs" aria-label="设置 xs" tooltip="设置">
              <GearGlyph />
            </IconButton>
            <IconButton size="micro" aria-label="设置 micro" tooltip="设置">
              <GearGlyph />
            </IconButton>
          </Row>
          <Row label="关闭">
            <CloseButton size="md" />
            <CloseButton />
            <CloseButton size="xs" />
            <CloseButton size="micro" />
            <CloseButton isDisabled />
          </Row>
          <Row label="危险">
            <Button variant="destructive">删除</Button>
            <Button variant="destructive" size="sm">
              删除
            </Button>
            <Button variant="destructive" isDisabled>
              删除
            </Button>
            <Button variant="danger">次要危险</Button>
          </Row>
          <Row label="键位">
            <Kbd>Ctrl</Kbd>
            <Kbd>⇧</Kbd>
            <KbdGroup keys={['Ctrl', 'Shift', 'P']} />
            <KbdGroup>
              <Kbd>Esc</Kbd>
            </KbdGroup>
          </Row>
          <Row label="徽章">
            <Badge>默认</Badge>
            <Badge tone="accent">强调</Badge>
            <Badge tone="ok">已完成</Badge>
            <Badge tone="fail">失败</Badge>
          </Row>
          <Row label="加载">
            <Spinner size="xs" />
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" label="加载中" />
          </Row>
        </>
      )}
    </ThemePair>
  )
}

export const EmptyNoticeVariantStates: Story = {
  name: 'EmptyState 图标媒体 / Notice 行内提示',
  parameters: {
    stateMatrix: {
      components: ['EmptyState', 'Notice'],
      states: STATES('default', 'empty', 'tone-info', 'tone-fail', 'loading'),
      declared: []
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <EmptyState
            media="icon"
            icon={<FolderGlyph />}
            title="没有改动"
            description="工作区和暂存区都是干净的。"
            action={<Button size="sm">刷新</Button>}
          />
          <Notice variant="hint">正在读取 git 状态…</Notice>
          <Notice variant="hint" icon={<Spinner size="xs" />}>
            加载中（带 Spinner）
          </Notice>
          <Notice variant="hint" tone="fail">
            无法读取仓库：不是 git 目录。
          </Notice>
          <Notice variant="hint" tone="ask">
            有 2 个文件冲突。
          </Notice>
        </>
      )}
    </ThemePair>
  )
}

function CommandDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onPress={() => setOpen(true)}>
        打开命令面板
      </Button>
      <CommandSurface isOpen={open} onOpenChange={setOpen} aria-label="命令面板">
        <CommandBody />
      </CommandSurface>
    </>
  )
}

function CommandBody() {
  return (
    <>
      <CommandSurfaceHeader>
        <InputGroup aria-label="命令">
          <InputGroupAddon align="start">
            <SearchGlyph />
          </InputGroupAddon>
          <InputGroupInput aria-label="命令" placeholder="输入命令或搜索会话…" />
        </InputGroup>
      </CommandSurfaceHeader>
      <CommandSurfaceBody>
        <Menu aria-label="命令" onAction={() => undefined}>
          <MenuItem icon={<GearGlyph />} shortcut="Ctrl+,">
            打开设置
          </MenuItem>
          <MenuItem icon={<SearchGlyph />} shortcut="Ctrl+F">
            在会话中查找
          </MenuItem>
          <MenuItem icon={<FolderGlyph />} description="E:/pi-desktop">
            切换项目
          </MenuItem>
        </Menu>
      </CommandSurfaceBody>
      <CommandSurfaceFooter>
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> 选择
        </span>
        <span>
          <Kbd>Enter</Kbd> 执行
        </span>
        <span>
          <Kbd>Esc</Kbd> 关闭
        </span>
      </CommandSurfaceFooter>
    </>
  )
}

export const CommandSurfaceStates: Story = {
  name: 'CommandSurface · 命令浮层壳',
  parameters: {
    stateMatrix: {
      components: ['CommandSurface', 'CommandSurfacePanel', 'CommandSurfaceHeader', 'CommandSurfaceBody', 'CommandSurfaceFooter'],
      states: STATES('default', 'open'),
      declared: STATES('open')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <>
          <CommandSurfacePanel aria-label="命令面板（内联预览）">
            <CommandBody />
          </CommandSurfacePanel>
          <CommandDemo />
        </>
      )}
    </ThemePair>
  )
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function FileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2h5l3 3v9H4z M9 2v3h3" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function TextGlyph({ text }: { text: string }) {
  return <span style={{ font: 'var(--w-medium) var(--t-caption) / 1 var(--font-mono)' }}>{text}</span>
}

function ImeProbe() {
  const [last, setLast] = useState('—')
  return (
    <InputGroup size="sm">
      <InputGroupInput
        aria-label="输入法守卫"
        placeholder="组字时回车不提交"
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key === 'Enter') setLast(event.currentTarget.value || '（空）')
        }}
      />
      <InputGroupAddon align="end">
        <InputGroupText>{last}</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  )
}

export const GapFillStates: Story = {
  name: '补缺 · 紧凑折叠、行变体、数据色徽标、提示文本、加载提示与菜单当前值',
  parameters: {
    stateMatrix: {
      components: [
        'CollapsibleHeader',
        'ListRow',
        'ListRowStatic',
        'Badge',
        'TooltipText',
        'Notice',
        'FindBar',
        'Button',
        'MenuItem',
        'isImeComposing',
        'CONTROL_ICON_SIZE'
      ],
      states: STATES('default', 'hover', 'selected', 'loading', 'empty', 'open', 'value-unknown'),
      declared: STATES('hover', 'open')
    }
  },
  render: () => (
    <ThemePair>
      {() => (
        <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
          <div style={{ display: 'grid' }}>
            <Collapsible>
              <CollapsibleHeader size="compact" chevron="end">读取 3 个文件 · 搜索 2 次</CollapsibleHeader>
              <CollapsiblePanel>
                <p style={{ margin: 0, color: 'var(--fg3)' }}>紧凑档：行高 --d-row，正文字号</p>
              </CollapsiblePanel>
            </Collapsible>
            <Collapsible defaultExpanded>
              <CollapsibleHeader size="compact" chevron="end" icon={<GearGlyph />}>思考 4 秒</CollapsibleHeader>
              <CollapsiblePanel>
                <p style={{ margin: 0, color: 'var(--fg3)' }}>展开内容</p>
              </CollapsiblePanel>
            </Collapsible>
          </div>
          <div style={{ display: 'grid', gap: 1 }}>
            <ListRow icon={<span style={{ display: 'inline-grid', width: CONTROL_ICON_SIZE.md, height: CONTROL_ICON_SIZE.md }}><FileGlyph /></span>} description="src/renderer/src/ui" trailing="3 分钟">
              两行内容 · Button.tsx
            </ListRow>
            <ListRow icon={<GearGlyph />} hoverHighlight={false} current>
              不显示悬停底色（键盘选中）
            </ListRow>
            <ListRow icon={<GearGlyph />} accessory={<IconButton size="xs" aria-label="更多" tooltip="更多"><GearGlyph /></IconButton>}>
              行尾附件不嵌在按钮里
            </ListRow>
            <ListRowStatic icon={<StatusSlot><StatusDot kind="running" /></StatusSlot>} trailing="02:14">
              非交互行（定时任务）
            </ListRowStatic>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-6)', alignItems: 'center' }}>
            {(['data-1', 'data-2', 'data-3', 'data-4', 'data-5', 'data-6', 'data-7', 'data-8'] as const).map((tone, index) => (
              <Badge key={tone} tone={tone} shape="square" aria-hidden="true">
                {String.fromCharCode(65 + index)}
              </Badge>
            ))}
            <Badge tone="data-3" data-testid="badge-data">数据色</Badge>
          </div>
          <p style={{ margin: 0, color: 'var(--fg2)' }}>
            账号 <TooltipText tooltip="someone@example.com">个人订阅</TooltipText> 已登录
          </p>
          <Notice loading compact>正在连接终端…</Notice>
          <Notice variant="hint" loading>页面加载中</Notice>
          <div style={{ width: 260 }}>
            <Notice tone="fail" compact action={<Button size="sm" variant="secondary">重试</Button>}>
              窄容器里操作按钮换到正文下方
            </Notice>
          </div>
          <FindBar value="error" onChange={() => undefined} onNext={() => undefined} onPrevious={() => undefined} hasMatches inputTestId="find-input" spellCheck={false} />
          <FindBar value="nothing" onChange={() => undefined} onNext={() => undefined} onPrevious={() => undefined} hasMatches={false} status="无结果" />
          <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
            <Button variant="secondary" tooltip="带提示的文字按钮" tooltipShortcut="Ctrl+R">运行</Button>
            <Button variant="plain" justify="start" style={{ width: 160 }}>左对齐撑满</Button>
          </div>
          <Menu aria-label="终端视图">
            <MenuItem id="font" textValue="字号" trailingValue="13">
              字号
            </MenuItem>
            <MenuItem id="stash" textValue="暂存" shortcut="Ctrl+Shift+S">
              暂存
            </MenuItem>
          </Menu>
          <ImeProbe />
        </div>
      )}
    </ThemePair>
  )
}

