import type { Meta, StoryObj } from '@storybook/react-vite'
import { SiteIcon, SourceCard } from './index'

const meta = {
  title: 'v3/原语/SourceCard',
  component: SourceCard,
  parameters: {
    layout: 'padded',
    stateMatrix: {
      components: ['SourceCard', 'SiteIcon'],
      states: ['default', 'hover', 'press', 'focus', 'loading', 'tone-ok', 'tone-ask', 'theme-light', 'theme-dark'],
      declared: ['hover', 'press', 'focus']
    }
  },
  args: {
    title: '官方文档：网页内容与来源核对',
    domain: 'docs.example.com',
    href: 'https://docs.example.com/guide',
    number: 1,
    label: '打开来源：官方文档',
    icon: <SiteIcon name="Example" />,
    status: '搜索命中',
    onOpen: () => {}
  }
} satisfies Meta<typeof SourceCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  name: 'SourceCard · 默认',
  render: (args) => <div style={{ maxWidth: 240 }}><SourceCard {...args} /></div>
}

export const ReadStates: Story = {
  name: 'SourceCard · 读取状态',
  render: (args) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--s-8)', maxWidth: 720 }}>
      <SourceCard {...args} status="搜索命中" meta={<time>2026-10-29</time>} />
      <SourceCard {...args} number={2} status="已取原文" statusTone="ok" icon={<SiteIcon name="Docs" tone={1} />} />
      <SourceCard {...args} number={3} status="部分原文" statusTone="ask" meta="缓存" icon={<SiteIcon name="Research" tone={3} />} />
    </div>
  )
}

export const Icons: Story = {
  name: 'SiteIcon · 已加载与回退',
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s-12)' }}>
      <SiteIcon name="Mozilla" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 18V6l8 12V6l8 12V6' fill='none' stroke='black' stroke-width='2'/%3E%3C/svg%3E" />
      <SiteIcon name="Waiting" />
      <SiteIcon name="Fallback" src="data:image/png;base64,invalid" tone={3} />
    </div>
  )
}
