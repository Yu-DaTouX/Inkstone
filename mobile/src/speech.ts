import { Alert, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'

interface SpeechInputNative {
  recognize(): Promise<string | null>
  stop(): void
  cancel(): void
  openServiceSettings(): Promise<boolean>
}

export type SpeechPhase = 'idle' | 'starting' | 'listening' | 'processing'
export interface SpeechState { state: SpeechPhase; level: number }
const native = NativeModules.InkstoneSpeechInput as SpeechInputNative | undefined
let active = false
let cancelled = false
export function subscribeSpeech(listener: (event: SpeechState) => void) {
  const event = native ? new NativeEventEmitter(NativeModules.InkstoneSpeechInput).addListener('inkstone-speech-state', listener) : null
  return () => event?.remove()
}
export function stopSpeech() { native?.stop() }
export function isSpeechActive() { return active }
export function cancelSpeech() { cancelled = true; native?.cancel() }

/** The Android system recognizer returns text to the editor; sending stays a separate action. */
export async function recognizeSpeech(isCancelled: () => boolean = () => false): Promise<string | null> {
  if (Platform.OS !== 'android') throw new Error('当前只支持 Android 语音输入')
  if (!native) throw new Error('语音输入模块不可用，请重新安装完整的 Android 应用')
  if (active) throw new Error('已有语音输入正在进行')
  active = true
  cancelled = false
  try {
    try {
      if (cancelled || isCancelled()) return null
      return await native.recognize()
    } catch (error) {
      if ((error as { code?: string })?.code === 'speech_service_permission') {
        /* 缺权限的是系统里负责转写的应用，不是砚；给一个直达它权限页的入口 */
        Alert.alert('识别服务缺少麦克风权限', (error as Error).message, [
          { text: '取消', style: 'cancel' },
          { text: '去授权', onPress: () => void native.openServiceSettings() }
        ])
      }
      if ((error as { code?: string })?.code !== 'speech_permission_required') throw error
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
        title: '允许砚使用麦克风',
        message: '在输入框内录入语音，并通过手机的识别服务转成可编辑文字。识别服务可能联网。',
        buttonPositive: '继续',
        buttonNegative: '取消'
      })
      if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('未获得麦克风权限，可改用键盘语音输入')
      if (cancelled || isCancelled()) return null
      return await native.recognize()
    }
  } finally { active = false }
}
