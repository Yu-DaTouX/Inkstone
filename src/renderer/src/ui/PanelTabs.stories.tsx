import { useState, type ReactElement } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button, PanelTab, PanelTabCloseButton, PanelTabList, Sheet } from './index'

const meta = {
  title: 'v3/原语/PanelTabs',
  parameters: {
    layout: 'padded',
    stateMatrix: {
      components: ['PanelTab', 'PanelTabCloseButton', 'PanelTabList', 'Sheet'],
      states: ['default', 'selected', 'closable', 'focus', 'open', 'disabled', 'tone-ask'],
      declared: []
    }
  }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Glyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

interface DemoTab {
  id: string
  label: string
  icon: ReactElement
  pending?: boolean
  preview?: boolean
  muted?: boolean
  attention?: boolean
}

const TABS: DemoTab[] = [
  { id: 'changes', label: '更改', icon: <Glyph /> },
  { id: 'terminal', label: '终端', icon: <Glyph />, pending: true },
  { id: 'files', label: 'ledger.js', icon: <Glyph />, preview: true },
  { id: 'exited', label: 'pwsh', icon: <Glyph />, muted: true },
  { id: 'bell', label: 'bash', icon: <Glyph />, attention: true },
  { id: 'pr:12', label: '#12', icon: <Glyph /> }
]

function TabsDemo() {
  const [tabs, setTabs] = useState(TABS)
  const [active, setActive] = useState('terminal')
  return (
    <div style={{ width: 520, height: 32, display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
      <PanelTabList label="面板标签" data-testid="panel-tabs" onCloseFocused={(id) => setTabs((prev) => prev.filter((tab) => tab.id !== id))}>
        {tabs.map((tab) => (
          <PanelTab
            key={tab.id}
            id={tab.id}
            label={tab.label}
            icon={tab.icon}
            pending={tab.pending}
            preview={tab.preview}
            description={tab.preview ? '预览' : undefined}
            muted={tab.muted}
            attention={tab.attention}
            data-kind="demo"
            onDoubleClick={() => setTabs((prev) => prev.map((item) => (item.id === tab.id ? { ...item, preview: false } : item)))}
            active={tab.id === active}
            closeLabel={`关闭「${tab.label}」`}
            onSelect={() => setActive(tab.id)}
            onClose={() => setTabs((prev) => prev.filter((item) => item.id !== tab.id))}
          />
        ))}
      </PanelTabList>
    </div>
  )
}

export const Strip: Story = {
  name: '标签条 · 选中、忙碌点、预览斜体、已退出变灰、提醒闪烁、悬停换 X',
  render: () => <TabsDemo />
}

export const CloseButton: Story = {
  name: '关闭按钮',
  render: () => (
    <PanelTabCloseButton label="关闭" onClose={() => undefined}>
      <Glyph />
    </PanelTabCloseButton>
  )
}

function SheetDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onPress={() => setOpen(true)}>打开抽屉</Button>
      <Sheet isOpen={open} onOpenChange={setOpen} label="右侧面板">
        <div style={{ padding: 'var(--s-16)' }}>窄屏时右栏以抽屉形式出现，Esc 或点遮罩关闭。</div>
      </Sheet>
    </>
  )
}

export const SheetOpen: Story = {
  name: 'Sheet 抽屉',
  render: () => <SheetDemo />
}
