import type { CSSProperties, ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import {
  Button,
  Dialog,
  IconButton,
  Input,
  Label,
  Menu,
  MenuItem,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  TextField
} from './index'
import tokens from '../design/tokens.json'

/**
 * v3 原语工作台（WP-03）。
 *
 * 只覆盖本轮 UI 代理交付的原语（Button / IconButton / TextField / Menu / Dialog / Tabs），
 * 与 UI 代理自己的故事文件分开；显示外观一律来自 tokens.css 与 ui.css，本文件不写控件样式。
 * 主题与密度由 .storybook/preview.ts 的全局装饰器切换；下面的矩阵用内联自定义属性
 * 或 `color-scheme` 在单页里并列展示同一套令牌。
 */
const meta = {
  title: 'v3/原语',
  parameters: { layout: 'padded' }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/* ---------- Button ---------- */

export const ButtonVariants: Story = {
  name: 'Button · 变体与尺寸',
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
      </Row>
      <Row label="状态">
        <Button isDisabled onPress={() => undefined}>
          禁用
        </Button>
        <IconButton aria-label="关闭">
          <CloseGlyph />
        </IconButton>
        <IconButton aria-label="设置">
          <GearGlyph />
        </IconButton>
      </Row>
    </div>
  )
}

/** 点击后按钮获得键盘焦点；焦点环由统一令牌 --accent 提供。 */
export const ButtonClickFocus: Story = {
  name: 'Button · 点击获得焦点',
  render: () => (
    <Button variant="primary" onPress={() => undefined}>
      点击我
    </Button>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole('button', { name: '点击我' })
    await userEvent.click(button)
    await expect(button).toHaveFocus()
  }
}

/* ---------- TextField（input） ---------- */

export const TextFieldStates: Story = {
  name: 'TextField · 状态',
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <TextField>
        <Label>会话标题</Label>
        <Input placeholder="未命名会话" />
        <Text slot="description">改名只影响本地记录。</Text>
      </TextField>
      <TextField isDisabled>
        <Label>模型 ID</Label>
        <Input defaultValue="commandcode/deepseek/deepseek-v4.1-flash" />
      </TextField>
      <TextField isInvalid isRequired>
        <Label>工作目录</Label>
        <Input defaultValue="E:/work/old" />
        <Text slot="errorMessage">路径不存在。</Text>
      </TextField>
    </div>
  )
}

/* ---------- Menu ---------- */

export const MenuInline: Story = {
  name: 'Menu · 会话操作',
  render: () => (
    <Menu aria-label="会话操作" onAction={() => undefined} style={{ maxWidth: 220 }}>
      <MenuItem>重命名</MenuItem>
      <MenuItem>在文件管理器中显示</MenuItem>
      <MenuItem>复制会话 ID</MenuItem>
      <MenuItem>归档</MenuItem>
    </Menu>
  )
}

/* ---------- Dialog ---------- */

export const DialogSurface: Story = {
  name: 'Dialog · 确认卡',
  render: () => (
    <div style={{ maxWidth: 420 }}>
      <Dialog title="删除这个会话？" aria-label="删除会话">
        <p style={{ margin: 0, color: 'var(--fg2)', fontSize: 'var(--t-body)', lineHeight: 'var(--t-body-lh)' }}>
          会话记录会从列表移除，pi 的会话文件不会被删除。
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
    </div>
  )
}

/* ---------- Tabs ---------- */

export const TabsBasic: Story = {
  name: 'Tabs · 视图切换',
  render: () => (
    <Tabs aria-label="视图">
      <TabList>
        <Tab id="chat">对话</Tab>
        <Tab id="files">文件</Tab>
        <Tab id="diff">改动</Tab>
      </TabList>
      <TabPanels>
        <TabPanel id="chat">对话内容</TabPanel>
        <TabPanel id="files">文件列表</TabPanel>
        <TabPanel id="diff">增删差异</TabPanel>
      </TabPanels>
    </Tabs>
  )
}

/* ---------- 三档密度 ---------- */

const DENSITIES = ['compact', 'standard', 'comfortable'] as const
type DensityName = (typeof DENSITIES)[number]

export const DensityMatrix: Story = {
  name: '密度 · 紧凑 / 标准 / 宽松',
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--s-16)' }}>
      {DENSITIES.map((name) => (
        <DensityColumn key={name} name={name} />
      ))}
    </div>
  )
}

function DensityColumn({ name }: { name: DensityName }) {
  const d = tokens.density[name]
  const style = {
    '--d-row': `${d.row}px`,
    '--d-prose': `${d.prose}px`,
    '--d-prose-lh': `${d['prose-lh']}px`,
    '--d-gap': `${d.gap}px`
  } as CSSProperties
  return (
    <section
      style={{
        ...style,
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-12)'
      }}
    >
      <header style={{ color: 'var(--fg2)', fontSize: 'var(--t-meta)', lineHeight: 'var(--t-meta-lh)' }}>
        {name} · row {d.row} / prose {d.prose}/{d['prose-lh']} / gap {d.gap}
      </header>
      <div style={{ display: 'grid', gap: 'var(--d-gap)', marginTop: 'var(--s-8)' }}>
        {['未命名会话', '重构设计令牌', '验收 Storybook'].map((title) => (
          <div
            key={title}
            style={{
              height: 'var(--d-row)',
              display: 'flex',
              alignItems: 'center',
              paddingInline: 'var(--s-8)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--bg)',
              color: 'var(--fg)',
              fontSize: 'var(--t-ui)'
            }}
          >
            {title}
          </div>
        ))}
      </div>
      <p
        style={{
          margin: 'var(--s-12) 0 0',
          color: 'var(--fg)',
          fontSize: 'var(--d-prose)',
          lineHeight: 'var(--d-prose-lh)'
        }}
      >
        正文行随密度变化，用于核对外壳在窄行下仍可读。
      </p>
    </section>
  )
}

/* ---------- 浅色 / 深色 ---------- */

export const ThemeMatrix: Story = {
  name: '主题 · 浅色 / 深色',
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--s-16)' }}>
      {(['light', 'dark'] as const).map((mode) => (
        <ThemeColumn key={mode} mode={mode} />
      ))}
    </div>
  )
}

function ThemeColumn({ mode }: { mode: 'light' | 'dark' }) {
  // color-scheme 让 light-dark() 在这个子树里取对应一侧，因此同一页可并列两种主题。
  const style = {
    colorScheme: mode,
    background: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-md)',
    padding: 'var(--s-16)',
    display: 'grid',
    gap: 'var(--s-12)'
  } as CSSProperties
  return (
    <section style={style}>
      <strong style={{ fontSize: 'var(--t-title)', fontWeight: 'var(--t-title-w)' }}>{mode === 'light' ? '浅色' : '深色'}</strong>
      <p style={{ margin: 0, color: 'var(--fg2)', fontSize: 'var(--t-ui)' }}>次要文字 fg2</p>
      <p style={{ margin: 0, color: 'var(--fg3)', fontSize: 'var(--t-meta)' }}>元信息 fg3 · 12/16</p>
      <div
        style={{
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-pop)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--s-12)',
          display: 'flex',
          gap: 'var(--s-8)',
          alignItems: 'center'
        }}
      >
        <StatusDot color="var(--run)" label="运行中" />
        <StatusDot color="var(--ask)" label="等你确认" />
        <StatusDot color="var(--stall)" label="停滞" />
        <StatusDot color="var(--fail)" label="失败" />
      </div>
      <Button variant="primary" onPress={() => undefined}>
        主按钮
      </Button>
    </section>
  )
}

/* ---------- 局部小组件（仅用于故事内布局） ---------- */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--s-8)', alignItems: 'center' }}>
      <span style={{ width: 48, color: 'var(--fg3)', fontSize: 'var(--t-meta)' }}>{label}</span>
      {children}
    </div>
  )
}

function StatusDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-6)', fontSize: 'var(--t-meta)', color: 'var(--fg2)' }}>
      <span
        aria-hidden="true"
        style={{
          width: 'var(--size-dot)',
          height: 'var(--size-dot)',
          borderRadius: 'var(--r-full)',
          background: color,
          flex: '0 0 auto'
        }}
      />
      {label}
    </span>
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
