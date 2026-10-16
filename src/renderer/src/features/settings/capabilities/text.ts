/**
 * 能力与插件设置里 v3 自己新增的短文案。
 *
 * ⚠️ 为什么不加进两份 i18n JSON：那是并发共享热点，任务边界禁止修改。
 * 能复用现有键的（`cap.*` / `pkg.*` / `market.*` / `set.*` / `ui.*`）一律用
 * `useT()`，这里只收「v3 新分组标题 + 明确回退/限制说明」这类新句子；
 * 迁移定稿后再并入正式 i18n 并删除本文件。
 */
import { useI18n } from '../../../i18n'

export type CapsTextKey =
  | 'extensions'
  | 'prompts'
  | 'sectionReload'
  | 'mcpHostNote'
  | 'mcpNativeNote'
  | 'mcpNativeUnavailable'
  | 'mcpRunningBlock'
  | 'skillsLoadedNote'
  | 'extensionsBuiltinNote'
  | 'extensionsPackagesNote'
  | 'marketNoAutoNote'
  | 'promptsNote'
  | 'promptsNoSession'
  | 'promptsReadonly'
  | 'promptHiddenTag'
  | 'promptsHiddenHint'
  | 'promptsEmpty'
  | 'skillRemoveConfirm'
  | 'skillRemoveScopeChanged'
  | 'pkgStaleResult'
  | 'importFieldDescription'
  | 'importFieldTransport'
  | 'importFieldCommand'
  | 'importFieldArgs'
  | 'importFieldEnvKeys'
  | 'importFieldUrl'
  | 'installedNotLoaded'
  | 'loadFailed'
  | 'reloaded'

const ZH: Record<CapsTextKey, string> = {
  extensions: '扩展',
  prompts: '提示词',
  sectionReload: '重新读取',
  mcpHostNote: '这些是砚自己管理的 MCP 服务，与 pi 原生的 MCP 配置分开，两边不会自动互相迁移。',
  mcpNativeNote:
    'pi 原生 MCP 由 pi 自己管理（mcp.json）；这里是只读状态，与上面的砚宿主服务分开。',
  mcpNativeUnavailable:
    '当前运行实例未提供 pi 原生 MCP 命令，暂无法读取原生服务器状态。',
  mcpRunningBlock: '有会话正在运行任务，导入会断开旧连接，请等任务空闲后再试。',
  skillsLoadedNote:
    '列出的是当前运行实例已加载的技能。新装或改动的技能要等 pi 下次加载（新会话或重启运行实例）才生效。',
  extensionsBuiltinNote: '随砚分发，无需安装，也没有卸载入口。',
  extensionsPackagesNote:
    'pi 扩展以你的身份运行代码，砚没有沙箱。安装、更新、卸载都只在点击后执行，且对新会话生效。',
  marketNoAutoNote:
    '打开本页不会自动联网；只有点「搜索」或「下载」才会请求目录 / 写盘。',
  promptsNote:
    '提示词来自当前 pi 会话的命令注册表（与技能 / 扩展同源），这里只读展示。',
  promptsNoSession: '需要已连接 pi 会话才能读取提示词；先开始或打开一个会话再看。',
  promptsReadonly: '提示词没有独立的安装 / 卸载接口；编辑请按它声明的位置在原处进行。',
  promptHiddenTag: '隐藏于菜单',
  promptsHiddenHint:
    '标为「隐藏于菜单」的提示词只是不出现在补全菜单里，仍可正常调用，并非停用。',
  promptsEmpty: '当前会话没有注册提示词。',
  skillRemoveConfirm:
    '将删除本次会话的技能文件，不能撤销。想保留请先选「保留到我的技能」。',
  skillRemoveScopeChanged:
    '会话在确认前后发生了变化，本次移除未执行；请在新会话里重新确认。',
  pkgStaleResult:
    '项目在操作完成前已切换，本次结果未应用到当前列表；请确认新项目的状态。',
  importFieldDescription: '说明',
  importFieldTransport: '传输方式',
  importFieldCommand: '命令',
  importFieldArgs: '参数个数',
  importFieldEnvKeys: '环境变量（仅键名）',
  importFieldUrl: '服务地址（仅来源）',
  installedNotLoaded: '已安装，尚未加载',
  loadFailed: '读取失败',
  reloaded: '已重新读取'
}

const EN: Record<CapsTextKey, string> = {
  extensions: 'Extensions',
  prompts: 'Prompts',
  sectionReload: 'Reload',
  mcpHostNote:
    'These MCP servers are managed by Inkstone, separate from pi’s native MCP configuration. The two never migrate into each other automatically.',
  mcpNativeNote:
    'Native MCP is managed by pi itself (mcp.json); this is a read-only status view, kept separate from the host servers above.',
  mcpNativeUnavailable:
    'This runner does not expose pi’s native MCP command, so native server status cannot be read yet.',
  mcpRunningBlock:
    'A session is running; importing disconnects old connections. Try again when tasks are idle.',
  skillsLoadedNote:
    'These are the skills loaded by the current runner. New or changed skills take effect after pi next loads (new session or runner restart).',
  extensionsBuiltinNote: 'Shipped with Inkstone; nothing to install and no uninstall entry.',
  extensionsPackagesNote:
    'pi extensions run code as you; Inkstone has no sandbox. Install, update and remove run only on click and take effect for new sessions.',
  marketNoAutoNote:
    'Opening this page makes no network calls; only Search or Download performs a request or writes to disk.',
  promptsNote:
    'Prompts come from the current pi session’s command registry (same source as skills / extensions); shown read-only here.',
  promptsNoSession:
    'Connect a pi session first to read prompts; start or open a session.',
  promptsReadonly:
    'Prompts have no separate install / uninstall API; edit them where they are declared.',
  promptHiddenTag: 'Hidden from menu',
  promptsHiddenHint:
    'Prompts marked “Hidden from menu” are only omitted from the completion menu; they still work and are not disabled.',
  promptsEmpty: 'No prompts are registered in the current session.',
  skillRemoveConfirm:
    'This deletes the skill files for this session and cannot be undone. To keep it, choose “Keep in my skills” first.',
  skillRemoveScopeChanged:
    'The session changed while confirming, so nothing was removed. Confirm again in the new session.',
  pkgStaleResult:
    'The project changed before the operation finished, so the result was not applied to the current list. Check the new project’s state.',
  importFieldDescription: 'Description',
  importFieldTransport: 'Transport',
  importFieldCommand: 'Command',
  importFieldArgs: 'Argument count',
  importFieldEnvKeys: 'Environment keys (names only)',
  importFieldUrl: 'Server URL (origin only)',
  installedNotLoaded: 'Installed, not loaded',
  loadFailed: 'Load failed',
  reloaded: 'Reloaded'
}

export function capsText(lang: string, key: CapsTextKey): string {
  return (lang === 'en-US' ? EN : ZH)[key]
}

export function useCapsText(): (key: CapsTextKey) => string {
  const { lang } = useI18n()
  return (key) => capsText(lang, key)
}
