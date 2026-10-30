import { useState, type CSSProperties, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  AnimatedHeight,
  AnimatedWidth,
  AsciiRule,
  AsciiScale,
  AsciiSpark,
  Badge,
  Button,
  CompletionSweep,
  CondensingHeader,
  Expand,
  MorphIcon,
  MotionList,
  useCondensingHeader,
  DiffStat,
  Heading,
  IconButton,
  Kbd,
  KbdGroup,
  ListRow,
  RailValue,
  Separator,
  ShimmerText,
  StatusDot,
  Swatch,
  TermSpinner,
  Text
} from './index'

const meta = {
  title: 'v3/风格样例',
  parameters: { layout: 'padded' }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const STATES = (...names: string[]) => names

const SURFACES = [
  ['surface-0', '最底层：窗口外沿与凹陷区'],
  ['side', '左栏玻璃'],
  ['bg', '主区画布'],
  ['sunken', '代码块、内嵌区'],
  ['bubble', '用户气泡'],
  ['surface', '卡片'],
  ['surface-3', '浮层：菜单、输入框']
] as const

const INKS = [
  ['fg', '正文'],
  ['fg2', '次级正文、未选中控件'],
  ['fg3', '元信息、说明'],
  ['ascii-ink', 'ASCII 强笔画'],
  ['ascii-dim', 'ASCII 弱笔画、分隔']
] as const

const SIGNALS = [
  ['accent', '交互与焦点（唯一强调色）'],
  ['run', '运行中'],
  ['ask', '等你决定'],
  ['stall', '停滞'],
  ['ok', '完成'],
  ['fail', '失败'],
  ['add', '增加行'],
  ['del', '删除行']
] as const

const TYPE_STEPS = [
  ['display', '32 / 40', '首页问候，一屏只出现一次'],
  ['title', '20 / 28', '页面与弹层标题'],
  ['heading', '14 / 20 · 600', '分组标题'],
  ['prose', '14 / 20', '正文（宽松档 16 / 28）'],
  ['body', '13 / 20', '控件文字、列表行'],
  ['footnote', '12 / 16', '说明、次级行'],
  ['caption', '11 / 16', '元数字、徽标']
] as const

const MOTION_TIERS = [
  ['反馈', '--dur-fast · --dur-snap', '--ease-snap', '悬停、按下、开关；60–120ms，永远不等待'],
  ['过渡', '--dur-base · --dur-sheet', '--ease / --ease-inout', '菜单、面板、栏位移动；200–300ms，只动透明度与位移'],
  ['表演', '--dur-slow · --dur-flourish', '--ease-spring', '首页、启动、完成、空状态；可炫技，但不在流式输出与输入框附近']
] as const

export const Tokens: Story = {
  name: '令牌 · 表面层级、墨色、信号色',
  parameters: {
    stateMatrix: {
      components: ['Swatch', 'Separator'],
      states: STATES('default', 'theme-light', 'theme-dark', 'orientation-horizontal')
    }
  },
  render: () => (
    <ThemePair>
      <Section title="表面层级（由深到浅，浮层最亮）">
        <div style={gridStyle}>
          {SURFACES.map(([name, use]) => (
            <Chip key={name} name={name} use={use} fill={`var(--${name})`} />
          ))}
        </div>
      </Section>
      <Separator />
      <Section title="墨色：三级灰阶 + 两级 ASCII 笔画">
        <div style={gridStyle}>
          {INKS.map(([name, use]) => (
            <Chip key={name} name={name} use={use} fill={`var(--${name})`} />
          ))}
        </div>
      </Section>
      <Separator />
      <Section title="信号色：只表达状态，不做装饰">
        <div style={gridStyle}>
          {SIGNALS.map(([name, use]) => (
            <Chip key={name} name={name} use={use} fill={`var(--${name})`} />
          ))}
        </div>
      </Section>
      <Section title="数据色（图表专用）">
        <div style={{ display: 'flex', gap: 'var(--s-8)' }}>
          {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((tone) => (
            <Swatch key={tone} tone={tone} />
          ))}
        </div>
      </Section>
    </ThemePair>
  )
}

export const Typography: Story = {
  name: '字体 · 字号阶梯与双字族',
  parameters: {
    stateMatrix: {
      components: ['Heading', 'Text', 'DiffStat', 'RailValue'],
      states: STATES('default', 'theme-light', 'theme-dark', 'value-known')
    }
  },
  render: () => (
    <ThemePair>
      <Section title="字号阶梯：7 级，相邻级至少差 1px">
        <div style={{ display: 'grid', gap: 'var(--s-8)' }}>
          {TYPE_STEPS.map(([name, metric, use]) => (
            <div key={name} style={ladderRowStyle}>
              <span style={{ fontSize: `var(--t-${name})`, lineHeight: `var(--t-${name}-lh)`, fontWeight: name === 'display' || name === 'title' || name === 'heading' ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                砚 Inkstone 墨线
              </span>
              <span className="ui-meta-num" style={{ fontSize: 'var(--t-caption)' }}>{`${name} ${metric}`}</span>
              <span style={noteStyle}>{use}</span>
            </div>
          ))}
        </div>
      </Section>
      <Separator />
      <Section title="双字族：语言用无衬线，机器产出的东西用等宽">
        <Heading level={3} style={{ margin: 0, fontSize: 'var(--t-heading)' }}>
          正文里的数字保持无衬线：本轮改了 5 个文件，耗时 3 分钟。
        </Heading>
        <Text slot="description" style={{ color: 'var(--fg2)' }}>
          元数据统一用 <code>--font-num</code>：时间、增删行、Token、百分比、费用。
        </Text>
        <div style={metaRowStyle}>
          <span className="ui-meta-num">20:26</span>
          <span className="ui-meta-num">13h</span>
          <DiffStat added={165} removed={2} />
          <RailValue value="17.6M" unit="tok" />
          <RailValue value="98%" />
          <RailValue value="$7.38" />
          <RailValue glyph={{ kind: 'delta', added: 45, removed: 5 }} />
        </div>
        <p style={noteStyle}>
          路径与可点代码：等宽 + 强调色，无底色、悬停才下划线。普通行内代码：等宽 + 浅底 + 次级墨色，不着色。
        </p>
        <p style={{ margin: 0 }}>
          清单在 <code style={inlineCodeStyle}>npm run typecheck</code> 之后写进{' '}
          <code style={pathStyle}>.local-docs/STATUS.md</code>。
        </p>
      </Section>
    </ThemePair>
  )
}

export const TerminalElements: Story = {
  name: 'ASCII / 终端元素 · 结构而非纹理',
  parameters: {
    stateMatrix: {
      components: ['AsciiRule', 'AsciiSpark', 'TermSpinner', 'Kbd', 'KbdGroup', 'Badge'],
      states: STATES('default', 'loading', 'tone-accent', 'theme-light', 'theme-dark')
    }
  },
  render: () => (
    <ThemePair>
      <Section title="字符分隔线：回合边界、列表分组">
        <AsciiRule />
        <AsciiRule glyph="─" tone="ink" label="最近" />
        <AsciiRule glyph="┄" label="第 3 轮 · 20:26" align="center" />
      </Section>
      <Section title="字符柱：用量、频率等小型数据">
        <div style={metaRowStyle}>
          <AsciiSpark label="最近 14 天用量" values={[0, 1, 0, 3, 8, 2, 0, 0, 5, 9, 4, 0, 6, 7]} />
          <AsciiSpark label="本周" tone="accent" values={[2, 4, 6, 8, 6, 4, 9]} />
          <span style={noteStyle}>峰值一格用正文墨色，其余用 ASCII 墨色</span>
        </div>
      </Section>
      <Section title="终端式运行指示与键位">
        <div style={metaRowStyle}>
          <TermSpinner label="正在运行" />
          <span style={{ color: 'var(--fg2)' }}>运行 18 条命令</span>
          <span className="ui-meta-num">02:14</span>
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
          <Badge tone="run">运行</Badge>
        </div>
      </Section>
      <Section title="侧栏状态列：运行 / 等你 / 未读">
        <div style={{ display: 'grid', gap: 2, maxWidth: 280 }}>
          <ListRow icon={<TermSpinner />} trailing={<span className="ui-num ui-signal-run">3m</span>}>重构侧栏</ListRow>
          <ListRow signal="ask" icon={<StatusDot kind="awaiting" />} trailing={<span className="ui-num ui-signal-ask">2m</span>}>删除 .tmp 前等你确认</ListRow>
          <ListRow icon={<StatusDot kind="ready" />} trailing={<span className="ui-num">47m</span>}>完成未读</ListRow>
        </div>
      </Section>
      <p style={noteStyle}>
        用在：启动、首页问候区的字符场、回合分隔、空状态、字符柱、运行指示、命令前缀 ›。不用在：正文、按钮文字、卡片底纹、任何会让人以为是屏幕脏点的满屏纹理。
      </p>
    </ThemePair>
  )
}

export const TitlebarToggles: Story = {
  name: '标题栏 · 纯图标开关（位置固定，按下 = 浅底 + 下划线）',
  parameters: {
    stateMatrix: {
      components: ['IconButton'],
      states: STATES('default', 'selected', 'theme-light', 'theme-dark')
    }
  },
  render: () => <TitlebarDemo />
}

export const ThinkingScale: Story = {
  name: '字符刻度 · 思考档（七格，不支持的档置灰）',
  parameters: {
    stateMatrix: {
      components: ['AsciiScale'],
      states: STATES('default', 'selected', 'disabled', 'focus', 'theme-light', 'theme-dark'),
      declared: STATES('focus')
    }
  },
  render: () => <ThinkingScaleDemo />
}

export const Motion: Story = {
  name: '动效 · 反馈 / 过渡 / 表演三档',
  parameters: {
    stateMatrix: {
      components: ['Button', 'ShimmerText', 'CompletionSweep', 'AsciiSpark'],
      states: STATES('default', 'loading', 'press'),
      declared: STATES('press')
    }
  },
  render: () => <MotionDemo />
}

export const MotionPrimitives: Story = {
  name: '动效基元 · 高度 / 宽度 / 展开 / 收缩头部 / 图标形变 / 列表进出',
  parameters: {
    stateMatrix: {
      components: ['AnimatedHeight', 'AnimatedWidth', 'Expand', 'CondensingHeader', 'MorphIcon', 'MotionList'],
      states: STATES('default', 'open', 'theme-light', 'theme-dark')
    }
  },
  render: () => <MotionPrimitivesDemo />
}

const MOTION_ROWS = ['重构侧栏', '右栏分区折叠', '过程块展开', '改动卡抵达', '设置弹窗入场', '命令面板下落']

function MotionPrimitivesDemo() {
  const [lines, setLines] = useState(2)
  const [wide, setWide] = useState(false)
  const [open, setOpen] = useState(true)
  const [morph, setMorph] = useState(false)
  const [rows, setRows] = useState(MOTION_ROWS.slice(0, 4))
  const condense = useCondensingHeader('story')
  const shuffle = () => setRows((prev) => (prev.length > 3 ? [...prev.slice(1), prev[0]].slice(0, prev.length - 1) : MOTION_ROWS.slice(0, prev.length + 2)))
  return (
    <ThemePair>
      <Section title="AnimatedHeight · 内容增减时高度过渡">
        <div style={metaRowStyle}>
          <Button size="sm" variant="secondary" onPress={() => setLines((n) => (n >= 5 ? 1 : n + 1))}>
            {`行数 ${lines}`}
          </Button>
        </div>
        <AnimatedHeight>
          <div style={{ display: 'grid', gap: 'var(--s-4)', padding: 'var(--s-8)', borderRadius: 'var(--r-md)', boxShadow: 'var(--ring-line)' }}>
            {Array.from({ length: lines }, (_, index) => (
              <span key={index} style={{ color: 'var(--fg2)' }}>{`第 ${index + 1} 行 · 只动高度，不挤压文字`}</span>
            ))}
          </div>
        </AnimatedHeight>
      </Section>
      <Section title="AnimatedWidth · 文字按钮换词时宽度过渡">
        <Button size="sm" variant="secondary" onPress={() => setWide((value) => !value)}>
          <AnimatedWidth>{wide ? '发布分支到远端' : '推送'}</AnimatedWidth>
        </Button>
      </Section>
      <Section title="Expand · grid 0fr↔1fr 展开收起，内容延后淡入">
        <Button size="sm" variant="secondary" onPress={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开'}
        </Button>
        <Expand open={open}>
          <p style={{ margin: 0, padding: 'var(--s-8) 0', color: 'var(--fg2)' }}>右栏分区、侧栏分段和贪睡列表共用这一种展开：先让行高过渡，再让内容淡入；收起时内容先淡出，行高随后归零。</p>
        </Expand>
      </Section>
      <Section title="CondensingHeader · 滚动收缩头部（滞回 + scrollTop 补偿）">
        <div style={{ display: 'flex', flexDirection: 'column', height: 200, borderRadius: 'var(--r-md)', boxShadow: 'var(--ring-line)', overflow: 'hidden' }} onScrollCapture={condense.onScrollCapture}>
          <CondensingHeader
            state={condense}
            compact={<div style={{ padding: 'var(--s-4) var(--s-12)', color: 'var(--fg2)' }} className="ui-num">#128 · 12 files · +340 −52</div>}
          >
            <div style={{ display: 'grid', gap: 'var(--s-4)', padding: 'var(--s-12)' }}>
              <strong>设计整合第二阶段：动效基元</strong>
              <span style={{ color: 'var(--fg3)' }}>完整头部：标题、作者、分支与统计。向下滚过头部高度 + 32px 后收成一行，回到顶部 4px 内再展开。</span>
            </div>
          </CondensingHeader>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--s-12)', borderTop: 'var(--hair, 1px) solid var(--line)' }}>
            {Array.from({ length: 24 }, (_, index) => (
              <p key={index} style={{ margin: '0 0 var(--s-8)', color: 'var(--fg2)' }}>{`正文第 ${index + 1} 段`}</p>
            ))}
          </div>
        </div>
      </Section>
      <Section title="MorphIcon · 开关图标形变">
        <Button size="sm" variant="secondary" onPress={() => setMorph((value) => !value)}>
          <MorphIcon iconKey={morph ? 'close' : 'open'} icon={<span className="ui-num">{morph ? '×' : '+'}</span>} />
          {morph ? '还原' : '最大化'}
        </Button>
      </Section>
      <Section title="MotionList · 列表行进入 / 离开 / 重排（FLIP）">
        <Button size="sm" variant="secondary" onPress={shuffle}>
          轮换
        </Button>
        <MotionList style={{ display: 'grid', gap: 2, maxWidth: 280 }}>
          {rows.map((row) => (
            <ListRow key={row} trailing={<span className="ui-num">{row.length}</span>}>
              {row}
            </ListRow>
          ))}
        </MotionList>
      </Section>
    </ThemePair>
  )
}

function TitlebarDemo() {
  const [open, setOpen] = useState<Record<string, boolean>>({ bar: true, files: false, changes: true, terminal: false })
  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  return (
    <ThemePair>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        {(['bar', 'terminal', 'changes', 'files'] as const).map((key) => (
          <IconButton key={key} aria-label={key} pressedTone="mark" aria-pressed={open[key]} onPress={() => toggle(key)}>
            <PanelGlyph kind={key} />
          </IconButton>
        ))}
      </div>
      <p style={noteStyle}>文字只出现在悬停提示里；同一排按钮宽度不随状态变化。面板内已有标签页时，顶栏不再重复面板名。</p>
    </ThemePair>
  )
}

const SCALE_LEVELS = [
  ['off', '关'],
  ['minimal', '最低'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '极高'],
  ['max', '最高']
] as const

function ThinkingScaleDemo() {
  const [level, setLevel] = useState('medium')
  const [narrow, setNarrow] = useState('high')
  const supported = new Set(['off', 'high'])
  return (
    <ThemePair>
      <Section title="全部七档：已选格染档位色，其左各格用 ASCII 强笔画">
        <AsciiScale
          label="思考强度"
          tone={`var(--think-${level}, var(--accent-t))`}
          value={level}
          onChange={setLevel}
          options={SCALE_LEVELS.map(([id, label]) => ({ id, label }))}
        />
      </Section>
      <Section title="模型只支持关 / 高：其余格置灰，悬停说明原因">
        <AsciiScale
          label="思考强度"
          value={narrow}
          onChange={setNarrow}
          options={SCALE_LEVELS.map(([id, label]) => ({ id, label, isDisabled: !supported.has(id), title: supported.has(id) ? undefined : '当前模型不支持这一档' }))}
        />
      </Section>
      <Section title="生成中整条禁用">
        <AsciiScale label="思考强度" value="low" onChange={() => {}} isDisabled options={SCALE_LEVELS.map(([id, label]) => ({ id, label }))} />
      </Section>
    </ThemePair>
  )
}

function MotionDemo() {
  const [done, setDone] = useState(false)
  const [seed, setSeed] = useState(0)
  return (
    <div style={{ display: 'grid', gap: 'var(--s-16)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content max-content max-content minmax(0, 1fr)', gap: 'var(--s-8) var(--s-16)', alignItems: 'baseline' }}>
        {MOTION_TIERS.map(([tier, duration, ease, use]) => (
          <div key={tier} style={{ display: 'contents' }}>
            <strong>{tier}</strong>
            <span className="ui-meta-num">{duration}</span>
            <span className="ui-meta-num">{ease}</span>
            <span style={noteStyle}>{use}</span>
          </div>
        ))}
      </div>
      <Separator />
      <div style={metaRowStyle}>
        <Button variant="secondary" onPress={() => setSeed((n) => n + 1)}>重放表演</Button>
        <Button variant="ghost" onPress={() => setDone((value) => !value)}>切换完成</Button>
        <ShimmerText>正在思考</ShimmerText>
        <CompletionSweep done={done} />
        <AsciiSpark key={seed} label="重放的字符柱" values={[1, 3, 6, 9, 7, 4, 2, 5, 8, 3]} />
      </div>
      <p style={noteStyle}>
        「减少动效」开启时：表演档全部停在终态，过渡档只保留透明度，反馈档不变。流式输出、自动滚动、审批卡片与输入框附近不放表演档。
      </p>
    </div>
  )
}

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 'var(--s-16)' }}>
      {(['light', 'dark'] as const).map((scheme) => (
        <div key={scheme} style={{ ...panelStyle, colorScheme: scheme }}>
          <span className="ui-meta-num" style={{ fontSize: 'var(--t-caption)' }}>{scheme === 'light' ? '浅色' : '深色'}</span>
          {children}
        </div>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 'var(--s-8)' }}>
      <h3 style={{ margin: 0, fontSize: 'var(--t-footnote)', lineHeight: 'var(--t-footnote-lh)', fontWeight: 500, color: 'var(--fg3)' }}>{title}</h3>
      {children}
    </section>
  )
}

function Chip({ name, use, fill }: { name: string; use: string; fill: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: 'var(--s-8)', alignItems: 'center' }}>
      <span style={{ width: 28, height: 28, borderRadius: 'var(--r-sm)', background: fill, boxShadow: 'var(--ring-line)' }} aria-hidden />
      <span style={{ minWidth: 0 }}>
        <span className="ui-meta-num" style={{ display: 'block', fontSize: 'var(--t-caption)' }}>{`--${name}`}</span>
        <span style={{ ...noteStyle, display: 'block' }}>{use}</span>
      </span>
    </div>
  )
}

function PanelGlyph({ kind }: { kind: 'bar' | 'terminal' | 'changes' | 'files' }) {
  const paths: Record<typeof kind, string> = {
    bar: 'M3 3.5h10v9H3zM9.5 3.5v9',
    terminal: 'M3 5l3 3-3 3M8 11h5',
    changes: 'M4 2.5h6l2.5 2.5v8.5H4zM6.5 7h3M8 5.5v3M6.5 10.5h3',
    files: 'M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z'
  }
  return (
    <svg width="var(--size-icon)" height="var(--size-icon)" viewBox="0 0 16 16" aria-hidden="true">
      <path d={paths[kind]} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: 'var(--s-16)',
  alignContent: 'start',
  padding: 'var(--s-16)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  boxShadow: 'var(--ring-line)'
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: 'var(--s-12)'
}

const ladderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 140px minmax(0, 1fr)',
  gap: 'var(--s-12)',
  alignItems: 'baseline'
}

const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--s-12)'
}

const noteStyle: CSSProperties = {
  margin: 0,
  color: 'var(--fg3)',
  fontSize: 'var(--t-footnote)',
  lineHeight: 'var(--t-footnote-lh)'
}

const inlineCodeStyle: CSSProperties = {
  padding: '1px var(--s-4)',
  borderRadius: 'var(--r-xs)',
  background: 'var(--code-inline-bg)',
  color: 'var(--fg2)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.9em'
}

const pathStyle: CSSProperties = {
  color: 'var(--accent-t)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.9em'
}
