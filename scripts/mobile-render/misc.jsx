import React from 'react'

export const SafeAreaProvider = (props) => <div data-rn="SafeAreaProvider">{props.children}</div>
export const SafeAreaView = (props) => <div data-rn="SafeAreaView" data-style={JSON.stringify(props.style ?? {})}>{props.children}</div>
export const useSafeAreaInsets = () => ({ top: 24, bottom: 16, left: 0, right: 0 })

export const SvgXml = (props) => <svg data-rn="Icon" aria-label={props.accessibilityLabel} data-size={props.width} />
export const Path = () => null
const Svg = (props) => <svg>{props.children}</svg>
export default Svg

const store = (globalThis.__keychain ??= { entry: null })
export const ACCESSIBLE = { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'x' }
export const getGenericPassword = async () => store.entry
export const setGenericPassword = async (username, password) => { store.entry = { username, password } }
export const resetGenericPassword = async () => { store.entry = null }
export const WebView = () => null
