export const CREDENTIAL_VAULT_ERROR = 'CredentialVaultError'

export function credentialVaultMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const marker = `${CREDENTIAL_VAULT_ERROR}: `
  const at = text.indexOf(marker)
  return at < 0 ? null : text.slice(at + marker.length).trim() || null
}
