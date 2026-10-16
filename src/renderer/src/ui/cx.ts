/**
 * v3 原语内部的类名拼接。
 *
 * 只做「过滤空值 + 空格连接」一件事，不引入 clsx / classnames。
 * 组件不吞掉调用方的 `className`：模块仍可追加自己的版面类或探针钩子。
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
