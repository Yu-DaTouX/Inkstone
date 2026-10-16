import Headless from '@xterm/headless'
import Serialize from '@xterm/addon-serialize'
import type { Terminal, ITerminalAddon } from '@xterm/headless'

export class TerminalScreen {
  private readonly terminal: Terminal
  private readonly serializer = new Serialize.SerializeAddon()
  private pending = Promise.resolve()
  private sequence = 0

  constructor(cols: number, rows: number) {
    this.terminal = new Headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon)
  }
  write(data: string, seq: number): void {
    this.pending = this.pending.then(() => new Promise<void>((done) => {
      this.terminal.write(data, () => { this.sequence = seq; done() })
    }))
  }
  resize(cols: number, rows: number, seq: number): void {
    this.pending = this.pending.then(() => { this.terminal.resize(cols, rows); this.sequence = seq })
  }
  async settled() {
    await this.pending
    return { seq: this.sequence, cols: this.terminal.cols, rows: this.terminal.rows }
  }
  async snapshot() {
    await this.pending
    return { data: this.serializer.serialize(), seq: this.sequence, cols: this.terminal.cols, rows: this.terminal.rows }
  }
  dispose(): void { void this.pending.finally(() => this.terminal.dispose()) }
}
