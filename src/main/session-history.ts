import { planHistoryRead } from '../shared/session-chain'
import { readSessionMessages, type ReadResult } from './session-reader'
import type { SessionChainStore } from './session-chain-service'
import type { UIMessage } from '../shared/ipc'

export type HistorySegmentHydrator = (sessionFile: string, messages: UIMessage[]) => Promise<UIMessage[]>

export type HistoryImageLocalizer = (mimeType: string, data: string) => string

export async function readChainMessages(
  headFile: string,
  chains: SessionChainStore | null | undefined,
  hydrate?: HistorySegmentHydrator,
  localizeImage?: HistoryImageLocalizer
): Promise<ReadResult | null> {
  const readOne = async (file: string): Promise<ReadResult | null> => {
    const result = await readSessionMessages(file, localizeImage ? { localizeImage } : undefined).catch(() => null)
    if (!result) return null
    const isolated = structuredClone(result.messages)
    let messages = hydrate
      ? await hydrate(file, isolated).catch(() => isolated)
      : isolated
    if (result.sourceCwd) {
      messages = messages.map((message) => ({ ...message, sourceCwd: result.sourceCwd }))
    }
    return { ...result, messages }
  }

  if (process.env.YAN_NO_CHAIN_HISTORY === '1') return readOne(headFile)
  if (!chains) return readOne(headFile)
  await chains.load()
  const plan = planHistoryRead(chains.chainOf(headFile))
  const files = plan.length ? plan : [headFile]

  const messages: ReadResult['messages'] = []
  let total = 0
  let truncated = 0
  let bytes = 0
  let sessionId: string | undefined
  let sourceCwd: string | undefined
  let read = 0
  let missing = 0

  for (const file of files) {
    const result = await readOne(file)
    if (!result) {
      missing += 1
      continue
    }
    const activeFile = files.at(-1)
    messages.push(...result.messages.map(message => file === activeFile ? message : {
      ...message,
      id: `history:${result.sessionId ?? file}:${message.id}`
    }))
    total += result.total
    truncated += result.truncated
    bytes += result.bytes
    if (read === 0) sourceCwd = result.sourceCwd
    else if (sourceCwd !== result.sourceCwd) sourceCwd = undefined
    if (result.sessionId) sessionId = result.sessionId
    read += 1
  }

  if (!read) return readOne(headFile)
  return {
    messages,
    total,
    truncated,
    bytes,
    ...(sessionId ? { sessionId } : {}),
    ...(sourceCwd ? { sourceCwd } : {}),
    segments: read,
    missing
  }
}
