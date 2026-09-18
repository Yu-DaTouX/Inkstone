/**
 * 主工作区里的子代理详情入口。
 *
 * 组件实现仍与旧预览共用，避免两套转录、停止和合并逻辑逐渐分叉；
 * placement 明确告诉它不要再去隐藏右侧原生浏览器视图。
 */
export { SubagentPreview as SubagentDetails } from '../toolbar/SubagentPreview'

