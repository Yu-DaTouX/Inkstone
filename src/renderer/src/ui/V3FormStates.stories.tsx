import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  Checkbox,
  CheckboxGroup,
  ComboBox,
  FieldError,
  Input,
  Label,
  ListBoxItem,
  Radio,
  RadioGroup,
  SearchField,
  Select,
  Switch,
  Text,
  TextArea,
  TextField
} from './index'

/**
 * v3 表单原语逐状态矩阵（组件工作台）。
 *
 * 覆盖 `ui/index.ts` 现有的字段类正式导出：默认 / 悬停 / 键盘焦点 / 禁用 /
 * 错误（invalid）/ 必填 / 只读 / 选中 / 半选 / 空值。外观全部来自
 * `tokens.css` 与 `ui.css`，本文件只写版面。
 *
 * 诚实边界：hover / focus 只通过 `parameters.stateMatrix.declared` 声明，
 * 没有被指针或键盘实测；不调用宿主 API，选项与文案全部是固定本地样例。
 * `scripts/test-v3-story-coverage.mjs` 只核对「能解析 + 覆盖清单一致」，
 * 不代替交互、a11y 或视觉验收。
 */
const meta = {
  title: 'v3/表单状态',
  parameters: { layout: 'padded' }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const STATES = (...names: string[]) => names

/* ---------- 单行文本 ---------- */

export const TextFieldStates: Story = {
  name: 'TextField · 默认 / 禁用 / 必填 / 只读 / 错误',
  parameters: {
    stateMatrix: {
      components: ['TextField'],
      states: STATES('default', 'hover', 'focus', 'disabled', 'invalid', 'required', 'readonly'),
      declared: STATES('hover', 'focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <TextField label="会话标题" placeholder="未命名会话" description="改名只影响本地记录。" />
      <TextField label="模型 ID" defaultValue="commandcode/deepseek/deepseek-v4.1-flash" isDisabled />
      <TextField label="工作目录" isInvalid isRequired defaultValue="E:/work/old" errorMessage="路径不存在。" />
      <TextField label="会话 ID" defaultValue="sess_9f2c" isReadOnly description="只读字段仍可聚焦选中文本。" />
    </div>
  )
}

/* ---------- 多行文本 ---------- */

export const TextAreaStates: Story = {
  name: 'TextArea · 默认 / 禁用 / 只读 / 错误',
  parameters: {
    stateMatrix: {
      components: ['TextArea'],
      states: STATES('default', 'focus', 'disabled', 'invalid', 'readonly'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <TextArea label="补充说明" placeholder="随内容增高" rows={3} />
      <TextArea label="固定内容" defaultValue="只读的多行文本。" isReadOnly />
      <TextArea label="被禁用的说明" defaultValue="不可编辑。" isDisabled />
      <TextArea label="提交信息" isInvalid errorMessage="提交信息不能为空。" />
    </div>
  )
}

/* ---------- 搜索 ---------- */

export const SearchFieldStates: Story = {
  name: 'SearchField · 默认 / 空值 / 禁用 / 错误',
  parameters: {
    stateMatrix: {
      components: ['SearchField'],
      states: STATES('default', 'focus', 'disabled', 'invalid', 'empty'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <SearchField label="搜索会话" placeholder="输入标题或路径" />
      <SearchField label="空值" placeholder="还没有输入" />
      <SearchField label="禁用" defaultValue="已归档" isDisabled />
      <SearchField label="错误" isInvalid errorMessage="搜索词太短。" />
    </div>
  )
}

/* ---------- 复选框 ---------- */

export const CheckboxStates: Story = {
  name: 'Checkbox / CheckboxGroup · 选中 / 半选 / 错误',
  parameters: {
    stateMatrix: {
      components: ['Checkbox', 'CheckboxGroup'],
      states: STATES('default', 'selected', 'indeterminate', 'focus', 'disabled', 'invalid'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <div style={{ display: 'grid', gap: 'var(--s-8)' }}>
        <Checkbox>默认</Checkbox>
        <Checkbox defaultSelected>已选</Checkbox>
        <Checkbox isIndeterminate>半选</Checkbox>
        <Checkbox isDisabled>禁用</Checkbox>
        <Checkbox isDisabled defaultSelected>
          禁用且已选
        </Checkbox>
      </div>
      <CheckboxGroup label="工具权限" isInvalid errorMessage="至少选择一项。">
        <Checkbox value="read">读取文件</Checkbox>
        <Checkbox value="write">写入文件</Checkbox>
      </CheckboxGroup>
      <CheckboxGroup label="禁用的组" isDisabled>
        <Checkbox value="one">选项一</Checkbox>
        <Checkbox value="two">选项二</Checkbox>
      </CheckboxGroup>
    </div>
  )
}

/* ---------- 开关 ---------- */

export const SwitchStates: Story = {
  name: 'Switch · 开 / 关 / 禁用',
  parameters: {
    stateMatrix: {
      components: ['Switch'],
      states: STATES('default', 'selected', 'focus', 'disabled'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-8)', maxWidth: 360 }}>
      <Switch>前台运行</Switch>
      <Switch defaultSelected>等待时播放提示音</Switch>
      <Switch isDisabled>禁用（关闭）</Switch>
      <Switch isDisabled defaultSelected>
        禁用（开启）
      </Switch>
    </div>
  )
}

/* ---------- 单选 ---------- */

export const RadioStates: Story = {
  name: 'Radio / RadioGroup · 选中 / 错误 / 禁用',
  parameters: {
    stateMatrix: {
      components: ['Radio', 'RadioGroup'],
      states: STATES('default', 'selected', 'focus', 'disabled', 'invalid'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <RadioGroup label="思考档" defaultValue="balanced">
        <Radio value="fast">快速</Radio>
        <Radio value="balanced">均衡</Radio>
        <Radio value="deep" isDisabled>
          深入（禁用）
        </Radio>
      </RadioGroup>
      <RadioGroup label="优先级" isInvalid errorMessage="请选择一个优先级。">
        <Radio value="low">低</Radio>
        <Radio value="high">高</Radio>
      </RadioGroup>
      <RadioGroup label="禁用的组" isDisabled defaultValue="a">
        <Radio value="a">甲</Radio>
        <Radio value="b">乙</Radio>
      </RadioGroup>
    </div>
  )
}

/* ---------- 下拉选择 ---------- */

export const SelectStates: Story = {
  name: 'Select · 默认 / 占位 / 禁用 / 必填 / 错误',
  parameters: {
    stateMatrix: {
      components: ['Select'],
      states: STATES('default', 'open', 'focus', 'disabled', 'invalid', 'required'),
      declared: STATES('open', 'focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <Select label="思考档" placeholder="请选择" defaultSelectedKey="balanced">
        <ListBoxItem id="fast">快速</ListBoxItem>
        <ListBoxItem id="balanced">均衡</ListBoxItem>
        <ListBoxItem id="deep">深入</ListBoxItem>
      </Select>
      <Select label="未选择" placeholder="占位文字">
        <ListBoxItem id="one">选项一</ListBoxItem>
        <ListBoxItem id="two">选项二</ListBoxItem>
      </Select>
      <Select label="禁用" isDisabled placeholder="不可选">
        <ListBoxItem id="one">选项一</ListBoxItem>
      </Select>
      <Select label="必填" isRequired placeholder="必填项" isInvalid errorMessage="请选择一项。">
        <ListBoxItem id="one">选项一</ListBoxItem>
        <ListBoxItem id="two">选项二</ListBoxItem>
      </Select>
    </div>
  )
}

/* ---------- 可输入下拉 ---------- */

export const ComboBoxStates: Story = {
  name: 'ComboBox · 默认 / 过滤 / 禁用 / 错误',
  parameters: {
    stateMatrix: {
      components: ['ComboBox'],
      states: STATES('default', 'open', 'focus', 'disabled', 'invalid'),
      declared: STATES('open', 'focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <ComboBox label="模型" inputPlaceholder="输入以过滤" defaultInputValue="deep">
        <ListBoxItem id="deepseek">deepseek-v4.1-flash</ListBoxItem>
        <ListBoxItem id="deepseek-pro">deepseek-v4.1-pro</ListBoxItem>
      </ComboBox>
      <ComboBox label="禁用" inputPlaceholder="不可输入" isDisabled>
        <ListBoxItem id="one">选项一</ListBoxItem>
      </ComboBox>
      <ComboBox label="错误" inputPlaceholder="选择一个" isInvalid errorMessage="没有匹配的模型。">
        <ListBoxItem id="one">选项一</ListBoxItem>
      </ComboBox>
    </div>
  )
}

/* ---------- 自定义组合：覆盖 RAC 构建块 ---------- */

export const CustomFieldComposition: Story = {
  name: '自定义组合 · Label / Input / Text / FieldError',
  parameters: {
    stateMatrix: {
      components: ['TextField', 'Label', 'Input', 'Text', 'FieldError'],
      states: STATES('default', 'focus', 'disabled', 'invalid', 'visible'),
      declared: STATES('focus')
    }
  },
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s-16)', maxWidth: 360 }}>
      <TextField name="custom-title">
        <Label>自定义标题字段</Label>
        <Input placeholder="用构建块自己拼" />
        <Text slot="description">描述与错误都由调用方放位。</Text>
        <FieldError>这里显示校验错误。</FieldError>
      </TextField>
      <TextField name="custom-invalid" isInvalid isRequired>
        <Label>必填且错误</Label>
        <Input defaultValue="" />
        <FieldError>标题不能为空。</FieldError>
      </TextField>
      <TextField name="custom-disabled" isDisabled>
        <Label>禁用字段</Label>
        <Input defaultValue="只读的原始值" />
      </TextField>
    </div>
  )
}
