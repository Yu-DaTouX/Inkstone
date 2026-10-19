import { useState, type CSSProperties } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Slider } from './index'

const meta = {
  title: 'v3/原语/Slider',
  component: Slider,
  parameters: {
    layout: 'padded',
    stateMatrix: {
      components: ['Slider'],
      states: ['default', 'disabled', 'invalid', 'orientation-horizontal', 'orientation-vertical'],
      declared: []
    }
  }
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

const column: CSSProperties = { display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }

export const Default: Story = {
  name: 'Slider · 默认（非受控）',
  args: {
    label: '上下文压缩阈值',
    defaultValue: 40,
    minValue: 0,
    maxValue: 100,
    step: 5,
    showValue: true
  },
  render: (args) => (
    <div style={column}>
      <Slider {...args} />
      <Slider label="温度" defaultValue={0.7} minValue={0} maxValue={1} step={0.1} showValue />
    </div>
  )
}

export const Controlled: Story = {
  name: 'Slider · 受控',
  render: () => <ControlledSlider />
}

function ControlledSlider() {
  const [value, setValue] = useState(30)
  return (
    <div style={column}>
      <Slider
        label="最大并发工具调用"
        value={value}
        onChange={(next) => setValue(next as number)}
        minValue={1}
        maxValue={10}
        step={1}
        showValue
      />
      <span style={{ color: 'var(--fg2)', fontSize: 'var(--t-footnote)' }}>当前：{value}</span>
    </div>
  )
}

export const Range: Story = {
  name: 'Slider · 范围值',
  args: {
    label: '保留区间',
    defaultValue: [20, 80],
    minValue: 0,
    maxValue: 100,
    step: 1,
    showValue: true,
    thumbLabels: ['下限', '上限']
  },
  render: (args) => (
    <div style={column}>
      <Slider {...args} />
    </div>
  )
}

export const Disabled: Story = {
  name: 'Slider · 禁用',
  args: {
    label: '窗口缩放（由系统决定）',
    defaultValue: 60,
    showValue: true,
    isDisabled: true
  },
  render: (args) => (
    <div style={column}>
      <Slider {...args} />
    </div>
  )
}

export const LongLabel: Story = {
  name: 'Slider · 长标签（中英）',
  args: {
    label: '请求超时前的重试次数（Retries before the request times out，长标签不截断）',
    defaultValue: 3,
    minValue: 0,
    maxValue: 10,
    step: 1,
    showValue: true
  },
  render: (args) => (
    <div style={{ ...column, maxWidth: 420 }}>
      <Slider {...args} />
    </div>
  )
}

export const Invalid: Story = {
  name: 'Slider · 错误与说明',
  args: {
    label: '每日 Token 上限',
    description: '超过上限后本机停止自动续跑，不会删除会话。',
    errorMessage: '上限必须高于已用量 120K。',
    defaultValue: 90,
    minValue: 0,
    maxValue: 100,
    step: 1,
    isInvalid: true,
    showValue: true,
    thumbLabels: ['上限']
  },
  render: (args) => (
    <div style={column}>
      <Slider {...args} />
    </div>
  )
}

export const Vertical: Story = {
  name: 'Slider · 竖向',
  args: {
    label: '音量',
    defaultValue: 45,
    orientation: 'vertical',
    showValue: true
  },
  render: (args) => (
    <div style={{ display: 'flex', gap: 'var(--s-24)', alignItems: 'flex-start' }}>
      <div style={{ width: 120 }}>
        <Slider {...args} />
      </div>
    </div>
  )
}
