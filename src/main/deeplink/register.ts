/**
 * 把 `inkstone://` 注册为系统默认协议处理器。
 *
 * 只依赖一个最小的注册器接口（`app.setAsDefaultProtocolClient`），因此可以
 * 用假对象单测；真正的 Electron `app` 由主进程入口传入。
 *
 * 开发态（未打包）Windows/Linux 必须把「可执行文件 + 入口脚本」一起注册，
 * 否则系统会直接启动 Electron 本体而不是本项目。
 */
import { DEEPLINK_SCHEME } from './protocol'

export interface ProtocolRegistrar {
  setAsDefaultProtocolClient(scheme: string, execPath?: string, args?: string[]): boolean
}

export interface DeepLinkRegisterOptions {
  /** `app.isPackaged`。 */
  isPackaged: boolean
  /** `process.execPath`。 */
  execPath: string
  /** 开发态入口脚本（`process.argv[1]`）；打包态不需要。 */
  appPath?: string
}

/**
 * 注册协议处理器，返回系统是否接受。
 *
 * 打包态直接注册 scheme；开发态带上 execPath 与入口脚本，让系统在再次
 * 唤醒时回到当前项目而不是裸 Electron。拿不到入口脚本时如实返回 false，
 * 不注册一个会把应用启动错的处理器。
 */
export function registerDeepLinkProtocol(registrar: ProtocolRegistrar, options: DeepLinkRegisterOptions): boolean {
  if (options.isPackaged) return registrar.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
  if (!options.appPath) return false
  return registrar.setAsDefaultProtocolClient(DEEPLINK_SCHEME, options.execPath, [options.appPath])
}
