import { parentPort, workerData } from 'node:worker_threads'
import { runWorkflowSandbox, type AgentReply, type SandboxInput } from './sandbox'
import type { WorkerToHost, HostToWorker } from './protocol'

const port = parentPort
if (port) {
  const pending = new Map<number, (reply: AgentReply) => void>()
  const post = (message: WorkerToHost): void => port.postMessage(message)
  port.on('message', (message: HostToWorker) => {
    if (message?.type !== 'agent-result') return
    const resolve = pending.get(message.seq)
    if (!resolve) return
    pending.delete(message.seq)
    resolve(message.reply)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    post({ type: 'log', text: `未等待的调用失败：${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 500) })
  })
  void runWorkflowSandbox(workerData as SandboxInput, {
    agent: (seq, prompt, options) => new Promise<AgentReply>((resolve) => {
      pending.set(seq, resolve)
      post({ type: 'agent', seq, prompt, options })
    }),
    phase: (title) => post({ type: 'phase', title }),
    log: (text) => post({ type: 'log', text }),
    fatal: (error) => post({ type: 'fatal', error })
  }).then(
    (outcome) => post(outcome.ok ? { type: 'done', json: outcome.json } : { type: 'failed', error: outcome.error }),
    (error: unknown) => post({ type: 'failed', error: error instanceof Error ? error.message : String(error) })
  )
}
