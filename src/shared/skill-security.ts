/**
 * Skill 正文的静态安全审查（实施-04 S6b-2）。
 *
 * Skill 是给模型看的指令材料，不是一个可以靠来源 / hash 自动变可信的
 * 程序。因此这里做的是**内容级闸门**：先记录可解释的 finding，再决定能否
 * 进入受管 staging。来源、SHA-256、项目授权和 runner 边界仍然各自成立；这
 * 个扫描器不替代它们，也不把「没命中规则」说成经过人工审计。
 *
 * 规则刻意分成两档：
 *   - high：提示注入、秘密读取/外传、破坏性文件操作、提权或隐藏行为，直接拒绝；
 *   - medium：命令执行、联网、环境变量访问等可用于正常 Skill 的能力，记录在证据中，
 *     但仍须经过已有的精确候选 / 项目授权。
 *
 * 这是共享纯逻辑，不能读文件、联网、执行命令，也不把正文发送到任何服务。
 */

export const SKILL_SECURITY_SCANNER_VERSION = 'yan-skill-security-1'
export const SKILL_SECURITY_MAX_FINDINGS = 128
const MAX_EXCERPT_LENGTH = 180

export type SkillSecuritySeverity = 'high' | 'medium'

export type SkillSecurityCode =
  | 'prompt-injection'
  | 'credential-access'
  | 'secret-exfiltration'
  | 'destructive-operation'
  | 'privilege-escalation'
  | 'command-execution'
  | 'network-access'
  | 'environment-access'

export type SkillSecurityFinding = {
  code: SkillSecurityCode
  severity: SkillSecuritySeverity
  path: string
  line: number
  excerpt: string
  detail: string
}

export type SkillSecurityReview = {
  version: 1
  scannerVersion: string
  ok: boolean
  scannedFiles: number
  scannedBytes: number
  findings: SkillSecurityFinding[]
  truncated: boolean
}

export type SkillSecurityInput = {
  path: string
  content: string | Uint8Array
}

type SecurityRule = {
  code: SkillSecurityCode
  severity: SkillSecuritySeverity
  detail: string
  pattern: RegExp
}

/*
 * 每条规则只在同一行产生一个 finding：这样审查回执稳定、不会因为一行里
 * 重复出现同一个词而被大量刷屏。规则不使用 g/y，避免跨文件复用时留下
 * RegExp.lastIndex 状态。
 */
const RULES: readonly SecurityRule[] = [
  {
    code: 'prompt-injection',
    severity: 'high',
    detail: '疑似要求模型忽略或覆盖既有指令 / 系统边界',
    pattern: /(?:ignore|disregard|override|bypass)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|system|developer|user)\s+(?:instructions?|messages?|rules?)/i
  },
  {
    code: 'prompt-injection',
    severity: 'high',
    detail: '疑似多语言提示注入或隐藏指令',
    pattern: /(?:ignora(?:r)?\s+(?:las\s+)?(?:instrucciones|reglas)\s+(?:anteriores|previas)|忽略(?:之前|以上|系统|开发者|用户).{0,12}(?:指令|提示|规则))/i
  },
  {
    code: 'prompt-injection',
    severity: 'high',
    detail: '疑似要求对用户隐藏行为或审查结果',
    pattern: /(?:do not tell|don't tell|keep (?:this|it) hidden|hide this from)\s+(?:the\s+)?user|不要(?:告诉|让).{0,16}用户|隐藏(?:这|此)(?:个|次)?(?:行为|结果|指令)?/i
  },
  {
    code: 'credential-access',
    severity: 'high',
    detail: '疑似读取凭证、密钥或私有配置文件',
    pattern: /(?:cat|type|get-content|read|open|load|copy|print|读取|打开|读取文件).{0,100}(?:auth\.json|\.ssh[\\/]|\.npmrc|api[_-]?key|access[_-]?token|password|secret|credential|凭证|密钥)/i
  },
  {
    code: 'secret-exfiltration',
    severity: 'high',
    detail: '疑似把凭证、环境变量或私有文件发送到外部',
    pattern: /(?:curl|wget|invoke-webrequest|invoke-restmethod|requests?\.(?:get|post|put)|fetch\s*\(|send|upload|exfiltrat|leak|上传|外传|发送).{0,140}(?:auth\.json|\.ssh[\\/]|secret|token|password|api[_-]?key|credential|environment|环境变量|凭证|密钥)/i
  },
  {
    code: 'destructive-operation',
    severity: 'high',
    detail: '疑似包含破坏性文件、磁盘或 Git 操作',
    pattern: /(?:rm\s+-rf|remove-item\b.{0,80}(?:-recurse|-force)|del\s+\/s(?:\s+\/q)?|rmdir\s+\/s|shutil\.rmtree|os\.(?:unlink|remove)|format(?:\.com)?\b|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f)|drop\s+database|wipe\s+(?:disk|drive)|删除全部|清空磁盘)/i
  },
  {
    code: 'privilege-escalation',
    severity: 'high',
    detail: '疑似要求提权、关闭安全措施或绕过审查',
    pattern: /(?:\bsudo\b|runas\b|start-process\b.{0,80}-verb\s+runas|disable\s+(?:antivirus|defender|security)|bypass\s+(?:security|approval|review)|关闭(?:杀毒|安全)|绕过(?:安全|授权|审查))/i
  },
  {
    code: 'command-execution',
    severity: 'medium',
    detail: 'Skill 包含命令 / 脚本执行指示，需要保留授权与边界证据',
    pattern: /(?:^|[`$>\s])(?:python(?:3)?|node|bash|sh|powershell|pwsh|cmd(?:\.exe)?|npm|npx|pip|uv)\b/i
  },
  {
    code: 'command-execution',
    severity: 'high',
    detail: '疑似直接调用任意代码执行 API',
    pattern: /(?:child_process|subprocess|os\.system|shell\s*=\s*true|\beval\s*\(|\bexec(?:ute)?\s*\(|\bspawn\s*\()/i
  },
  {
    code: 'network-access',
    severity: 'medium',
    detail: 'Skill 包含联网或 HTTP 请求指示，需要检查目标与数据流向',
    pattern: /(?:\bcurl\b|\bwget\b|invoke-webrequest|invoke-restmethod|requests?\.(?:get|post|put)|fetch\s*\(|https?:\/\/)/i
  },
  {
    code: 'environment-access',
    severity: 'medium',
    detail: 'Skill 读取进程环境或 shell 环境变量，需要确认没有接触凭证',
    pattern: /(?:process\.env\b|os\.environ\b|\$env:[A-Za-z_][A-Za-z0-9_]*|环境变量)/i
  }
]

function textOf(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: false }).decode(content)
}

function byteLengthOf(content: string | Uint8Array): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength
}

function excerptOf(line: string): string {
  const redacted = line
    .trim()
    .replace(/((?:token|password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
  if (redacted.length <= MAX_EXCERPT_LENGTH) return redacted
  return `${redacted.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
}

/** 格式化给事务 failure / CLI 回执的人读摘要，不包含完整正文。 */
export function formatSkillSecurityReview(review: SkillSecurityReview): string {
  if (review.findings.length === 0 && !review.truncated) {
    return `Skill 内容审查通过（${review.scannerVersion}；扫描 ${review.scannedFiles} 个文件）`
  }
  const findings = review.findings
    .slice(0, 8)
    .map((finding) => `${finding.severity}/${finding.code} ${finding.path}:${finding.line}「${finding.excerpt}」`)
    .join('；')
  const suffix = review.findings.length > 8 ? `；另有 ${review.findings.length - 8} 条` : ''
  const truncated = review.truncated ? '；审查结果被截断，拒绝继续' : ''
  return `Skill 内容审查${review.ok ? '通过（含提醒）' : '拒绝'}（${review.scannerVersion}）：${findings}${suffix}${truncated}`
}

/**
 * 对已下载 / 已声明的 Skill 正文做确定性扫描。
 * `ok=false` 由 high finding 或审查结果被截断触发；medium finding 会进入回执，
 * 不能被调用方当成「无风险」吞掉。finding 有数量上限时仍继续扫描正文，避免
 * 先出现大量 medium 就把后面的 high 风险截掉后放行。
 */
export function reviewSkillFiles(files: readonly SkillSecurityInput[]): SkillSecurityReview {
  const findings: SkillSecurityFinding[] = []
  let scannedBytes = 0
  let truncated = false

  for (const file of files) {
    const text = textOf(file.content)
    scannedBytes += byteLengthOf(file.content)
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue
        if (findings.length >= SKILL_SECURITY_MAX_FINDINGS) {
          truncated = true
          continue
        }
        findings.push({
          code: rule.code,
          severity: rule.severity,
          path: file.path,
          line: index + 1,
          excerpt: excerptOf(line),
          detail: rule.detail
        })
      }
    }
  }

  return {
    version: 1,
    scannerVersion: SKILL_SECURITY_SCANNER_VERSION,
    ok: !truncated && !findings.some((finding) => finding.severity === 'high'),
    scannedFiles: files.length,
    scannedBytes,
    findings,
    truncated
  }
}
