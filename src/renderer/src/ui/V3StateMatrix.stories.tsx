import { useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Avatar,
  avatarInitial,
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  PaneHeader,
  CompletionSweep,
  Dialog,
  DialogTrigger,
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
      components: ['Popover', 'Tooltip', 'TooltipTrigger', 'Focusable'],
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
