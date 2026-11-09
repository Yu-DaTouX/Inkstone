import { createContext, useContext } from 'react'

const ComposerMenuCloseContext = createContext<(() => void) | null>(null)

export const ComposerMenuCloseProvider = ComposerMenuCloseContext.Provider

export function useComposerMenuClose(): () => void {
  return useContext(ComposerMenuCloseContext) ?? noop
}

function noop(): void {}
