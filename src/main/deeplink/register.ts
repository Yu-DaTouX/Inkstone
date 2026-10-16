import { DEEPLINK_SCHEME } from './protocol'

export interface ProtocolRegistrar {
  setAsDefaultProtocolClient(scheme: string, execPath?: string, args?: string[]): boolean
}

export interface DeepLinkRegisterOptions {
  isPackaged: boolean
  execPath: string
  appPath?: string
}

export function registerDeepLinkProtocol(registrar: ProtocolRegistrar, options: DeepLinkRegisterOptions): boolean {
  if (options.isPackaged) return registrar.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
  if (!options.appPath) return false
  return registrar.setAsDefaultProtocolClient(DEEPLINK_SCHEME, options.execPath, [options.appPath])
}
