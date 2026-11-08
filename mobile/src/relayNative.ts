import { NativeModules } from 'react-native'
import { setFrameCipher, type FrameCipher } from './api/relay'

const native = NativeModules.InkstoneRelayCrypto as FrameCipher | undefined
if (native?.open && native.seal) setFrameCipher({ open: (key, frame, expected) => native.open(key, frame, expected), seal: (key, counter, text) => native.seal(key, counter, text) })
