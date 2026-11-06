import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react'

export interface Preloadable<P extends object> {
  Component: ComponentType<P>
  preload: () => Promise<unknown>
}

export function preloadable<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): Preloadable<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<unknown> | null = null
  const settle = (mod: { default: ComponentType<P> }): { default: ComponentType<P> } => {
    loaded = mod.default
    return mod
  }
  const Lazy = lazy(() => load().then(settle)) as LazyExoticComponent<ComponentType<P>>
  const Component = (props: P) => (loaded ? createElement(loaded, props) : createElement(Lazy, props as P & object))
  const preload = (): Promise<unknown> => {
    if (loaded) return Promise.resolve(loaded)
    pending ??= load().then(settle).catch(() => {
      pending = null
    })
    return pending
  }
  return { Component, preload }
}
