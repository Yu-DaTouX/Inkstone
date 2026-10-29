import { useSyncExternalStore } from 'react'
import { readPromptStash, subscribePromptStash, type PromptStashEntry } from './prompt-stash'

export function usePromptStashEntries(): PromptStashEntry[] {
  return useSyncExternalStore(subscribePromptStash, readPromptStash, readPromptStash)
}
