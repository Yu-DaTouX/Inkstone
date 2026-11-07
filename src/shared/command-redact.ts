const SECRET_FLAG = /(^|[\s;&|()])(--?(?:token|secret|passwd|password|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|auth|key))(\s*=\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi
const SECRET_ENV = /(^|[\s;&|()])([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY|_AUTH)[A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi
const SECRET_QUERY = /([?&](?:[A-Za-z0-9_.-]*(?:token|secret|key|password|auth|credential|signature|sig)[A-Za-z0-9_.-]*)=)([^&\s"']+)/gi
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi
const AUTH_HEADER = /(\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*)(?:(bearer|basic|token)\s+)?([^\s"',;]+)/gi
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/-]+=*)/gi

export const REDACTED = '***'

export function redactCommandSecrets(command: string): string {
  if (!command) return command
  return command
    .replace(AUTH_HEADER, (_match, head: string, scheme: string | undefined) => `${head}${scheme ? `${scheme} ` : ''}${REDACTED}`)
    .replace(BEARER, (_match, head: string) => `${head}${REDACTED}`)
    .replace(URL_USERINFO, (_match, head: string, _secret: string, at: string) => `${head}${REDACTED}${at}`)
    .replace(SECRET_QUERY, (_match, head: string) => `${head}${REDACTED}`)
    .replace(SECRET_FLAG, (_match, lead: string, flag: string, sep: string) => `${lead}${flag}${sep}${REDACTED}`)
    .replace(SECRET_ENV, (_match, lead: string, name: string, sep: string) => `${lead}${name}${sep}${REDACTED}`)
}
