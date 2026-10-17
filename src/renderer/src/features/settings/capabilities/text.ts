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
  mcpHostNote: '砚管理的 MCP 服务，与 pi 原生配置分开。',
  mcpNativeNote:
    'pi 原生 MCP，只读展示。',
  mcpNativeUnavailable:
    '当前无法读取 pi 原生 MCP 状态。',
  mcpRunningBlock: '有任务在运行，导入会断开旧连接，请空闲后再试。',
  skillsLoadedNote:
    '仅列出已加载的技能；新装或改动的需新会话才生效。',
  extensionsBuiltinNote: '随砚分发，无需安装，也没有卸载入口。',
  extensionsPackagesNote:
    '扩展以你的身份运行代码，无沙箱；对新会话生效。',
  marketNoAutoNote:
    '打开本页不联网；点「搜索」「下载」才请求。',
  promptsNote:
    '来自当前会话，只读。',
  promptsNoSession: '请先打开一个会话再查看提示词。',
  promptsReadonly: '提示词需在其声明位置编辑。',
  promptHiddenTag: '隐藏于菜单',
  promptsHiddenHint:
    '「隐藏于菜单」只是不进补全，并非停用，仍可调用。',
  promptsEmpty: '当前会话没有注册提示词。',
  skillRemoveConfirm:
    '将删除该技能文件，不能撤销；想保留先选「保留到我的技能」。',
  skillRemoveScopeChanged:
    '会话已变化，未执行移除，请重新确认。',
  pkgStaleResult:
    '项目已切换，结果未应用，请核对新项目。',
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
    'MCP servers managed by Inkstone, separate from pi’s.',
  mcpNativeNote:
    'pi native MCP, read-only.',
  mcpNativeUnavailable:
    'Native MCP status is unavailable.',
  mcpRunningBlock:
    'A task is running; importing drops connections. Retry when idle.',
  skillsLoadedNote:
    'Loaded skills only; new or changed ones apply in a new session.',
  extensionsBuiltinNote: 'Shipped with Inkstone; nothing to install and no uninstall entry.',
  extensionsPackagesNote:
    'Extensions run code as you, with no sandbox; apply to new sessions.',
  marketNoAutoNote:
    'No network until you click Search or Download.',
  promptsNote:
    'From the current session; read-only.',
  promptsNoSession:
    'Open a session to view prompts.',
  promptsReadonly:
    'Edit prompts where they are declared.',
  promptHiddenTag: 'Hidden from menu',
  promptsHiddenHint:
    '“Hidden from menu” only skips completion; it still works.',
  promptsEmpty: 'No prompts are registered in the current session.',
  skillRemoveConfirm:
    'Deletes the skill files and cannot be undone; to keep, choose “Keep in my skills” first.',
  skillRemoveScopeChanged:
    'Session changed; nothing removed. Confirm again.',
  pkgStaleResult:
    'Project changed; result not applied. Check the new project.',
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
