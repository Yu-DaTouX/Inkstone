/**
 * v3 基础原语（WP-04 / WP-05）。
 *
 * - 只写 `src/renderer/src/ui/**`；外观全部落在 `@layer primitives`
 *   （`ui.css` 及其聚合 / 组件自带的原语 CSS），v3 不导入任何 v2 样式。
 * - 交互、焦点、键盘与 ARIA 交给 React Aria Components（RAC）处理；
 *   图标用 lucide-react。
 * - 组件不吞掉调用方的 `className`：feature/pattern 模块仍可追加版面类。
 *
 * 共享接口（合同要求必须存在）：
 * `Button` `IconButton` `TextField` `Dialog` `Popover` `Menu` `MenuItem`
 * `Tabs` `TabList` `Tab` `TabPanel` `Tooltip`。
 */
import './ui.css'

export { cx } from './cx'

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button'
export { IconButton, type IconButtonProps } from './IconButton'
export {
  SearchField,
  TextArea,
  TextField,
  type FieldErrorContent,
  type SearchFieldProps,
  type TextAreaProps,
  type TextFieldProps
} from './TextField'
export { Checkbox, CheckboxGroup, type CheckboxGroupProps, type CheckboxProps } from './Checkbox'
export { Switch, type SwitchProps } from './Switch'
export { Radio, RadioGroup, type RadioGroupProps, type RadioProps } from './Radio'
export { Select, type SelectProps } from './Select'
export { ComboBox, type ComboBoxProps } from './ComboBox'
export {
  ListBox,
  ListBoxItem,
  ListBoxSection,
  type ListBoxItemProps,
  type ListBoxProps,
  type ListBoxSectionProps
} from './ListBox'
export {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
  type DialogProps,
  type DialogTriggerProps
} from './Dialog'
export { Popover, type PopoverProps } from './Popover'
export {
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  SubmenuTrigger,
  type MenuItemProps,
  type MenuProps,
  type MenuSectionProps,
  type MenuTriggerProps,
  type SubmenuTriggerProps
} from './Menu'
export {
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps
} from './Tabs'
export { Tooltip, TooltipTrigger, type TooltipProps, type TooltipTriggerComponentProps } from './Tooltip'
export { ToastRegion, showToast, toastQueue, type ShowToastOptions, type ToastContent, type ToastTone } from './Toast'
export { Badge, Kbd, type BadgeProps, type BadgeTone } from './Badge'
export { Meter, ProgressBar, Spinner, type MeterProps, type ProgressBarProps, type SpinnerProps } from './Progress'
export { Skeleton, type SkeletonProps, type SkeletonShape } from './Skeleton'
export { Separator, type SeparatorProps } from './Separator'
export { Slider, type SliderProps } from './Slider'
export {
  Tree,
  TreeChevron,
  TreeEmptyState,
  TreeHeader,
  TreeItem,
  TreeItemContent,
  TreeItemLabel,
  TreeSection,
  type TreeChevronProps,
  type TreeEmptyStateProps,
  type TreeHeaderProps,
  type TreeItemContentProps,
  type TreeItemLabelProps,
  type TreeItemProps,
  type TreeProps,
  type TreeSectionProps
} from './Tree'
export {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableEmptyState,
  TableFooter,
  TableHeader,
  TableLoadingState,
  type CellProps,
  type ColumnProps,
  type RowProps,
  type TableBodyProps,
  type TableEmptyStateProps,
  type TableFooterProps,
  type TableHeaderProps,
  type TableLoadingStateProps,
  type TableProps
} from './Table'
/* 表格数据排序纯函数：控件不保存第二套表格状态，调用方用它把 items 排成受控顺序。 */
export { sortRows, type TableSortDescriptor } from './table-model'
export { Splitter, type SplitterProps, type SplitterOrientation } from './Splitter'

/*
 * 供上层做自定义组合的 RAC 构建块：这些没有外观，直接转出以免每个调用点
 * 都去 import 'react-aria-components'。字段的 label / 描述 / 错误请优先用
 * 上面带 `label` / `description` / `errorMessage` 的封装。
 */
export {
  FieldError,
  Header,
  Heading,
  Input,
  Label,
  Text,
  type FieldErrorProps,
  type HeaderProps,
  type HeadingProps,
  type InputProps,
  type LabelProps,
  type TextProps
} from 'react-aria-components'
