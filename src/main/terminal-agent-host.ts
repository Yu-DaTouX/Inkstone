import {
  announceTerminalAgent,
  killTerminal,
  listTerminals,
  sameTerminalOwner,
  startTerminal,
  terminalAvailable,
  terminalStream,
  writeTerminal
} from './terminal'
import { listProcessTree } from './terminal-processes'
import { dangerGuardPrefs } from './settings'
import { loadDangerRules, renderTerminalText, type TerminalAgentHost } from './terminal-agent'

export function terminalAgentHost(): TerminalAgentHost {
  return {
    available: terminalAvailable,
    list: listTerminals,
    stream: terminalStream,
    start: startTerminal,
    write: writeTerminal,
    kill: killTerminal,
    announce: announceTerminalAgent,
    sameOwner: sameTerminalOwner,
    childCount: async (pid) => {
      const tree = await listProcessTree(pid)
      return tree.ok ? tree.processes.length + (tree.more ?? 0) : null
    },
    render: renderTerminalText,
    rules: loadDangerRules,
    prefs: dangerGuardPrefs,
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms))
  }
}
