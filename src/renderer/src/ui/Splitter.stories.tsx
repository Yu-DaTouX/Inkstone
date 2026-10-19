import { useState, type CSSProperties, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Splitter, type SplitterOrientation } from './index'

const meta = {
  title: 'v3/原语/Splitter',
  parameters: {
    layout: 'padded',
    stateMatrix: {
      components: ['Splitter'],
      states: ['default', 'disabled', 'orientation-horizontal', 'orientation-vertical'],
      declared: []
    }
  }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Vertical: Story = {
  name: '竖线 · 左右分栏',
  render: () => (
    <SplitDemo orientation="vertical" initial={160} min={0} max={420} label="调整左右宽度" />
  )
}

export const Horizontal: Story = {
  name: '横线 · 上下分行',
  render: () => (
    <SplitDemo
      orientation="horizontal"
      initial={90}
      min={0}
      max={200}
      height={220}
      label="调整上下高度"
    />
  )
}

export const Uncontrolled: Story = {
  name: '非受控值',
  render: function UncontrolledStory() {
    const [mirror, setMirror] = useState(140)
    return (
      <div style={{ display: 'grid', gap: 'var(--s-8)' }}>
        <Frame basis={mirror}>
          <Splitter
            orientation="vertical"
            defaultValue={140}
            min={0}
            max={420}
            step={10}
            onChange={setMirror}
            aria-label="调整左右宽度（非受控）"
          />
        </Frame>
        <p style={{ margin: 0, color: 'var(--fg2)', fontSize: 'var(--t-footnote)' }}>
          非受控：组件自持当前值，故事只镜像它报出的 onChange 值 {mirror}px。
        </p>
      </div>
    )
  }
}

export const Bounds: Story = {
  name: '区间与步长',
  render: function BoundsStory() {
    const [value, setValue] = useState(120)
    return (
      <div style={{ display: 'grid', gap: 'var(--s-8)' }}>
        <Frame basis={value}>
          <Splitter
            orientation="vertical"
            value={value}
            min={60}
            max={360}
            step={20}
            onChange={setValue}
            aria-controls="split-bounds-pane"
            aria-label="调整左右宽度（min 60 / max 360 / step 20）"
          />
        </Frame>
        <p style={{ margin: 0, color: 'var(--fg2)', fontSize: 'var(--t-footnote)' }}>
          受控值：{value}px（min 60 / max 360 / step 20，Home / End 到两端）
        </p>
      </div>
    )
  }
}

export const Narrow: Story = {
  name: '极小尺寸',
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s-16)', alignItems: 'flex-start' }}>
      <SplitDemo orientation="vertical" initial={48} min={0} max={96} width={96} height={120} label="调整极窄左右宽度" />
      <SplitDemo
        orientation="horizontal"
        initial={36}
        min={0}
        max={72}
        width={160}
        height={72}
        label="调整极矮上下高度"
      />
    </div>
  )
}

export const Grip: Story = {
  name: '短条拖柄',
  render: function GripStory() {
    const [value, setValue] = useState(180)
    return (
      <Frame basis={value}>
        <Splitter orientation="vertical" value={value} min={60} max={360} step={16} onChange={setValue} title="调整大小" aria-label="调整左右宽度（短条）" />
      </Frame>
    )
  }
}

export const Disabled: Story = {
  name: '禁用',
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-12)' }}>
      <SplitDemo orientation="vertical" initial={140} min={0} max={360} isDisabled label="禁用的竖线" />
      <SplitDemo
        orientation="horizontal"
        initial={80}
        min={0}
        max={180}
        height={160}
        isDisabled
        label="禁用的横线"
      />
    </div>
  )
}

interface SplitDemoProps {
  orientation?: SplitterOrientation
  initial: number
  min: number
  max: number
  step?: number
  width?: number
  height?: number
  isDisabled?: boolean
  label: string
  uncontrolled?: boolean
}

function SplitDemo({
  orientation = 'vertical',
  initial,
  min,
  max,
  step,
  width,
  height,
  isDisabled,
  label,
  uncontrolled
}: SplitDemoProps) {
  const [value, setValue] = useState(initial)
  return (
    <Frame orientation={orientation} basis={value} width={width} height={height}>
      <Splitter
        orientation={orientation}
        {...(uncontrolled ? { defaultValue: initial } : { value })}
        min={min}
        max={max}
        {...(step === undefined ? {} : { step })}
        isDisabled={isDisabled}
        onChange={setValue}
        aria-label={label}
      />
    </Frame>
  )
}

function Pane({ label, style }: { label: string; style: CSSProperties }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 0,
        minHeight: 0,
        padding: 'var(--s-8)',
        background: 'var(--side)',
        color: 'var(--fg2)',
        fontSize: 'var(--t-footnote)',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        ...style
      }}
    >
      {label}
    </div>
  )
}

interface FrameProps {
  orientation?: SplitterOrientation
  basis: number
  width?: number
  height?: number
  children: ReactNode
}

function Frame({ orientation = 'vertical', basis, width, height, children }: FrameProps) {
  const horizontal = orientation === 'horizontal'
  const style: CSSProperties = horizontal
    ? {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        width: width ?? 320,
        height: height ?? 200,
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden'
      }
    : {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        width: width ?? 420,
        height: height ?? 180,
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden'
      }
  return (
    <div style={style}>
      <Pane label="面板 A" style={{ flex: `0 0 ${basis}px` }} />
      {children}
      <Pane label="面板 B" style={{ flex: '1 1 0' }} />
    </div>
  )
}
