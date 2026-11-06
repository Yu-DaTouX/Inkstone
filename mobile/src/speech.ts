import { pick } from '../../src/shared/ui-lang'
import { Alert, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'

interface SpeechInputNative {
  recognize(): Promise<string | null>
  record(): Promise<string | null>
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

export function recordSpeech(isCancelled: () => boolean = () => false): Promise<string | null> {
  return runNative((module) => module.record(), isCancelled)
}

export function recognizeSpeech(isCancelled: () => boolean = () => false): Promise<string | null> {
  return runNative((module) => module.recognize(), isCancelled)
}

async function runNative(start: (module: SpeechInputNative) => Promise<string | null>, isCancelled: () => boolean): Promise<string | null> {
  if (Platform.OS !== 'android') throw new Error(pick('当前只支持 Android 语音输入', 'Voice input is Android only'))
  if (!native) throw new Error(pick('语音输入模块不可用，请重新安装完整的 Android 应用', 'Voice module unavailable. Reinstall the full Android app.'))
  if (active) throw new Error(pick('已有语音输入正在进行', 'Voice input already in progress'))
  active = true
  cancelled = false
  try {
    try {
      if (cancelled || isCancelled()) return null
      return await start(native)
    } catch (error) {
      if ((error as { code?: string })?.code === 'speech_service_permission') {
        Alert.alert(pick('识别服务缺少麦克风权限', 'Recognition service lacks microphone permission'), (error as Error).message, [
          { text: pick('取消', 'Cancel'), style: 'cancel' },
          { text: pick('去授权', 'Grant'), onPress: () => void native.openServiceSettings() }
        ])
      }
      if ((error as { code?: string })?.code !== 'speech_permission_required') throw error
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
        title: pick('允许砚使用麦克风', 'Allow Inkstone to use the microphone'),
        message: pick('在输入框内录入语音，并通过手机的识别服务转成可编辑文字。识别服务可能联网。', 'Record speech in the input and convert it to editable text with the phone recognition service, which may use the network.'),
        buttonPositive: pick('继续', 'Continue'),
        buttonNegative: pick('取消', 'Cancel')
      })
      if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error(pick('未获得麦克风权限，可改用键盘语音输入', 'Microphone permission denied. Try keyboard voice input.'))
      if (cancelled || isCancelled()) return null
      return await start(native)
    }
  } finally { active = false }
}
