import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

const env = globalThis.__rnEnv ??= {
  window: { width: 390, height: 844 },
  scheme: 'light',
  alerts: [],
  opened: [],
  shared: [],
  keyboardVisible: false,
  listeners: new Map(),
  nativeModules: {},
  platform: 'android'
}

export const flatten = (style) => {
  if (!style) return {}
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten))
  return typeof style === 'object' ? style : {}
}

const resolveStyle = (style, state) => flatten(typeof style === 'function' ? style(state) : style)

const attrs = (props, extra = {}) => {
  const style = resolveStyle(props.style, { pressed: false })
  const out = { 'data-style': JSON.stringify(style), ...extra }
  if (props.accessibilityLabel !== undefined) out['aria-label'] = props.accessibilityLabel
  if (props.accessibilityRole) out['data-role'] = props.accessibilityRole
  if (props.accessibilityState) out['data-state'] = JSON.stringify(props.accessibilityState)
  if (props.testID) out['data-testid'] = props.testID
  if (props.numberOfLines) out['data-lines'] = String(props.numberOfLines)
  if (style.display === 'none') out['data-hidden'] = '1'
  return out
}

const keep = (props) => (node) => { if (node) node.__props = props }

export const StyleSheet = {
  create: (styles) => styles,
  flatten,
  hairlineWidth: 1,
  absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }
}

export const View = forwardRef(function View(props, ref) {
  const node = useRef(null)
  useImperativeHandle(ref, () => ({
    measureInWindow: (cb) => cb(0, 0, env.window.width, env.window.height),
    measure: (cb) => cb(0, 0, env.window.width, env.window.height, 0, 0)
  }), [])
  useEffect(() => {
    props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: env.window.width, height: env.window.height } } })
  }, [])
  return <div ref={(n) => { node.current = n; keep(props)(n) }} {...attrs(props, { 'data-rn': 'View' })}>{props.children}</div>
})

export const Text = forwardRef(function Text(props, ref) {
  return <span ref={keep(props)} {...attrs(props, { 'data-rn': 'Text' })}>{props.children}</span>
})

export const Pressable = forwardRef(function Pressable(props, ref) {
  const children = typeof props.children === 'function' ? props.children({ pressed: false }) : props.children
  return <div ref={keep(props)} {...attrs(props, { 'data-rn': 'Pressable', 'data-disabled': props.disabled ? '1' : undefined })}>{children}</div>
})

export const ScrollView = forwardRef(function ScrollView(props, ref) {
  useImperativeHandle(ref, () => ({ scrollTo() {}, scrollToEnd() {} }), [])
  return <div ref={keep(props)} {...attrs(props, { 'data-rn': 'ScrollView' })}>{props.children}</div>
})

export const FlatList = forwardRef(function FlatList(props, ref) {
  useImperativeHandle(ref, () => ({ scrollToOffset() {}, scrollToEnd() {}, scrollToIndex() {} }), [])
  const data = props.data ?? []
  const part = (el) => (typeof el === 'function' ? React.createElement(el) : el)
  return <div ref={keep(props)} {...attrs(props, { 'data-rn': 'FlatList' })}>
    {part(props.ListHeaderComponent)}
    {data.length ? data.map((item, index) => <React.Fragment key={props.keyExtractor ? props.keyExtractor(item, index) : index}>{props.renderItem({ item, index })}</React.Fragment>) : part(props.ListEmptyComponent)}
    {part(props.ListFooterComponent)}
  </div>
})

export const TextInput = forwardRef(function TextInput(props, ref) {
  useImperativeHandle(ref, () => ({ focus() {}, blur() {}, clear() {} }), [])
  return <input ref={keep(props)} readOnly value={props.value ?? ''} placeholder={props.placeholder} {...attrs(props, { 'data-rn': 'TextInput', 'data-editable': props.editable === false ? '0' : '1' })} />
})

export const Modal = (props) => (props.visible ? <div ref={keep(props)} {...attrs(props, { 'data-rn': 'Modal' })}>{props.children}</div> : null)
export const Image = (props) => <img ref={keep(props)} {...attrs(props, { 'data-rn': 'Image' })} />
export const Switch = (props) => <div ref={keep(props)} {...attrs(props, { 'data-rn': 'Switch', 'data-value': String(!!props.value) })} />
export const KeyboardAvoidingView = (props) => <div ref={keep(props)} {...attrs(props, { 'data-rn': 'KAV' })}>{props.children}</div>
export const StatusBar = () => null
StatusBar.currentHeight = 24

class Value {
  constructor(v) { this.v = v }
  setValue(v) { this.v = v }
  interpolate() { return this }
  addListener() { return 'x' }
  removeListener() {}
  stopAnimation() {}
}
const done = (cb) => ({ start: (fn) => { (fn ?? cb)?.({ finished: true }) }, stop() {}, reset() {} })
export const Animated = {
  Value,
  View,
  Text,
  timing: (value, config) => ({ start: (fn) => { value.setValue(config.toValue); fn?.({ finished: true }) }, stop() {} }),
  sequence: () => done(),
  parallel: () => done(),
  loop: () => ({ start() {}, stop() {}, reset() {} }),
  delay: () => done(),
  createAnimatedComponent: (c) => c
}
export const Easing = { bezier: () => (t) => t, quad: (t) => t, out: (f) => f, linear: (t) => t, inOut: (f) => f }

const hook = (key) => (name, fn) => {
  const set = env.listeners.get(`${key}:${name}`) ?? new Set()
  set.add(fn)
  env.listeners.set(`${key}:${name}`, set)
  return { remove: () => set.delete(fn) }
}
export const emit = (key, name, ...args) => { for (const fn of env.listeners.get(`${key}:${name}`) ?? []) fn(...args) }

export const Alert = { alert: (title, message, buttons, options) => { env.alerts.push({ title, message, buttons: buttons ?? [], options }) } }
export const Platform = { get OS() { return env.platform }, Version: 34, select: (map) => map[env.platform] ?? map.default }
export const NativeModules = new Proxy({}, { get: (_, key) => env.nativeModules[key] })
export const Linking = { openURL: async (url) => { env.opened.push(url) }, getInitialURL: async () => null, addEventListener: hook('linking') }
export const Keyboard = { addListener: hook('keyboard'), isVisible: () => env.keyboardVisible, dismiss() {} }
export const AppState = { currentState: 'active', addEventListener: hook('appstate') }
export const BackHandler = { addEventListener: hook('back') }
export const Share = { share: async (content) => { env.shared.push(content) } }
export const PermissionsAndroid = { PERMISSIONS: { RECORD_AUDIO: 'a', POST_NOTIFICATIONS: 'n' }, RESULTS: { GRANTED: 'granted' }, request: async () => 'granted', check: async () => true }
export const AccessibilityInfo = { isReduceMotionEnabled: async () => true, addEventListener: hook('a11y') }
export class NativeEventEmitter { addListener() { return { remove() {} } } }
export const useColorScheme = () => env.scheme
export const useWindowDimensions = () => ({ ...env.window, scale: 2, fontScale: 1 })
export default { View, Text }
