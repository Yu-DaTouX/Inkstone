import type { MainPush, QueueEditOp, QueueItem, QueueSnapshot, QueueState } from '../shared/ipc'
import { pick } from '../shared/ui-lang'
import { isSubagentNotice } from '../shared/subagent-notice'
import { isHostTextNotice } from '../shared/host-notice-text'
import type { PiRpc } from './protocol'
import { consumeQueuedItem, reconcileQueueItems, sameQueueImages, snapshotQueue } from './queue-items'
import { applyQueueRewrite, planQueueEditOp, type QueueRewritePort, type QueueRewriteResult } from './queue-edit'
import { clearQueueFile, keepReclaimedQueue, loadQueue, saveQueue, type PersistedQueueItem } from './queue-persistence'

export interface QueueOwner {
  rpc: PiRpc | null
  sessionId?: string
  generation?: number
}

export interface QueueUpdate {
  steering: string[]
  followUp: string[]
  sessionId?: string
  generation?: number
}

export interface QueueCoordinatorDeps {
  owner(): QueueOwner
  push(message: MainPush): void
  pushAfterScope(emit: () => void): void
  loopStopping(): boolean
  confirmAdmission(): boolean
}

type QueueKind = 'steering' | 'followUp'
type QueueImages = QueueItem['images']
type EditResult = { ok: boolean; text?: string; images?: QueueImages; error?: string }

const KINDS = ['steering', 'followUp'] as const

function sameOwner(left: QueueOwner, right: QueueOwner): boolean {
  return left.rpc === right.rpc && left.sessionId === right.sessionId && left.generation === right.generation
}

function sessionChanged(): Error {
  return new Error(pick('会话已切换，队列操作已停止', 'Session changed; queue operation stopped'))
}

function notReady(): string {
  return pick('pi 尚未就绪', 'pi is not ready')
}

function visible(items: QueueItem[]): QueueItem[] {
  return items.filter(item => !isSubagentNotice(item.text) && !isHostTextNotice(item.text))
}

export class QueueCoordinator {
  state: QueueState = { steering: [], followUp: [] }
  pendingUpdate?: QueueUpdate
  consumedEmpty = { steering: 0, followUp: 0 }
  written: Promise<void> = Promise.resolve()
  private sequence = 0
  private consumed = new Set<string>()
  private removed: QueueItem[] = []
  private scope?: QueueOwner
  private busy = false
  private operations: Promise<void> = Promise.resolve()

  constructor(private readonly deps: QueueCoordinatorDeps) {}

  isEmpty(): boolean {
    return !this.state.steering.length && !this.state.followUp.length
  }

  snapshot(): QueueSnapshot {
    return snapshotQueue(this.state)
  }

  requireRpc(): PiRpc {
    const owner = this.deps.owner()
    if (!owner.rpc) throw new Error(pick('pi 尚未就绪或已经停止', 'pi is not ready or has stopped'))
    if (this.scope && !sameOwner(this.scope, owner)) throw sessionChanged()
    return owner.rpc
  }

  run<T>(work: () => Promise<T>, allowLoopStop = false): Promise<T> {
    const owner = this.deps.owner()
    const guarded = async (): Promise<T> => {
      if (!allowLoopStop && this.deps.loopStopping()) throw new Error(pick('正在按流式防护终止生成，暂不接受队列修改', 'Stream guard is stopping generation; queue changes are not accepted now'))
      if (!sameOwner(owner, this.deps.owner())) throw sessionChanged()
      if (!this.deps.confirmAdmission()) throw new Error(pick('同一工作目录的执行入场已失效，本次操作未开始', 'Execution admission for this working folder expired; the action did not start'))
      this.busy = true
      const scope = this.deps.owner()
      this.scope = scope
      try {
        return await work()
      } finally {
        this.scope = undefined
        this.busy = false
        const pending = this.pendingUpdate
        this.pendingUpdate = undefined
        const now = this.deps.owner()
        if (pending && pending.sessionId === now.sessionId && pending.generation === now.generation && scope.sessionId === pending.sessionId && scope.generation === pending.generation) {
          this.publish(pending.steering, pending.followUp)
        }
        this.consumed.clear()
      }
    }
    const current = this.operations.then(guarded, guarded)
    this.operations = current.then(() => undefined, () => undefined)
    return current
  }

  applyUpdate(update: QueueUpdate): void {
    if (this.busy) this.pendingUpdate = update
    else this.publish(update.steering, update.followUp)
  }

  reconcile(raw: string[], previous: QueueItem[]): QueueItem[] {
    return reconcileQueueItems(raw, previous, text => this.newItem(text))
  }

  publish(steering: string[], followUp: string[], clearing = false): QueueState {
    const next: QueueState = {
      steering: this.reconcile(this.liveTexts(steering, 'steering'), this.state.steering),
      followUp: this.reconcile(this.liveTexts(followUp, 'followUp'), this.state.followUp)
    }
    if (!clearing) {
      const retained = new Set([...next.steering, ...next.followUp].map(item => item.id))
      this.removed.push(...[...this.state.steering, ...this.state.followUp]
        .filter(item => !retained.has(item.id) && !this.consumed.has(item.id)))
    } else this.consumedEmpty = { steering: 0, followUp: 0 }
    return this.publishItems(next)
  }

  publishItems(next: QueueState): QueueState {
    next = {
      steering: next.steering.filter(item => !this.consumed.has(item.id)),
      followUp: next.followUp.filter(item => !this.consumed.has(item.id))
    }
    this.state = next
    this.deps.push({ ch: 'queue', payload: { steering: visible(next.steering), followUp: visible(next.followUp) } })
    this.written = this.persist().catch(() => undefined)
    return next
  }

  consume(text: string, images: NonNullable<QueueImages>): void {
    const removed = this.removed.findIndex(item => item.text.trim() === text.trim() && sameQueueImages(item.images, images))
    if (removed >= 0) {
      const [item] = this.removed.splice(removed, 1)
      if (this.busy) this.consumed.add(item.id)
      return
    }
    const next = consumeQueuedItem(this.state, text, images)
    if (!next) return
    const retained = new Set([...next.steering, ...next.followUp].map(item => item.id))
    for (const kind of KINDS) {
      for (const item of this.state[kind]) {
        if (retained.has(item.id)) continue
        if (this.busy) this.consumed.add(item.id)
        if (!item.text) this.consumedEmpty[kind]++
      }
    }
    this.publishItems(next)
    if (this.pendingUpdate && text) {
      for (const kind of KINDS) {
        const index = this.pendingUpdate[kind].indexOf(text)
        const count = this.pendingUpdate[kind].filter(value => value === text).length
        if (index >= 0 && count > next[kind].filter(item => item.text === text).length) {
          this.pendingUpdate[kind].splice(index, 1)
          break
        }
      }
    }
  }

  reset(emit = false): void {
    this.removed = []
    this.consumed.clear()
    this.consumedEmpty = { steering: 0, followUp: 0 }
    this.pendingUpdate = undefined
    this.state = { steering: [], followUp: [] }
    if (emit) this.deps.push({ ch: 'queue', payload: this.state })
  }

  clearSaved(): void {
    this.written = this.written.then(() => this.persist()).catch(() => undefined)
  }

  async flush(): Promise<void> {
    await this.written.catch(() => undefined)
    await this.persist().catch(() => undefined)
  }

  async reclaimSaved(): Promise<void> {
    const sessionId = this.deps.owner().sessionId
    if (!sessionId || !this.isEmpty()) return
    const saved = await loadQueue(sessionId).catch(() => null)
    if (!saved) return
    const items: QueueState = {
      steering: saved.items.steering.map(item => this.newItem(item.text, item.images)),
      followUp: saved.items.followUp.map(item => this.newItem(item.text, item.images))
    }
    if (items.steering.length || items.followUp.length) {
      this.deps.pushAfterScope(() => this.deps.push({ ch: 'queue-reclaimed', payload: { steering: saved.steering, followUp: saved.followUp, items, sessionId } }))
    }
    if (saved.lostImages) {
      this.deps.push({ ch: 'notify', payload: { id: `queue-lost-images-${Date.now()}`, method: 'notify', notifyType: 'warning', message: pick(`旧版本保存的排队消息里有 ${saved.lostImages} 张图片没能保存，需要重新添加。`, `${saved.lostImages} image(s) in queued messages saved by an older version could not be kept. Add them again.`) } })
    }
    await keepReclaimedQueue(sessionId).catch(() => undefined)
  }

  payload(item: Pick<QueueItem, 'text' | 'images'>): Record<string, unknown> {
    return { message: item.text, ...(item.images?.length ? {
      images: item.images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))
    } : {}) }
  }

  async submit(command: 'prompt' | 'steer' | 'follow_up', text: string, images: QueueImages, kind: QueueKind, payload: Record<string, unknown>) {
    const item = this.newItem(text, images)
    const rpc = this.requireRpc()
    this.state = { ...this.state, [kind]: [...this.state[kind], item] }
    let queued = false
    try {
      const res = await rpc.command<{ disposition?: string }>(command, payload)
      this.requireRpc()
      queued = res.success && (!res.data?.disposition || res.data.disposition === 'queued')
      return res
    } finally {
      const owner = this.deps.owner()
      if (!queued && this.scope?.rpc === owner.rpc && this.scope.sessionId === owner.sessionId) {
        this.state = { ...this.state, [kind]: this.state[kind].filter(value => value.id !== item.id) }
      }
    }
  }

  async restoreSnapshot(snapshot: QueueSnapshot): Promise<{ ok: boolean; error?: string }> {
    const restore = (kind: QueueKind) => snapshot[kind].map((text, index) =>
      this.newItem(text, snapshot.items?.[kind][index]?.text === text ? snapshot.items[kind][index].images : undefined))
      .filter(item => item.text.length > 0 || item.images?.length)
    const steering = restore('steering')
    const followUp = restore('followUp')
    if (steering.length === 0 && followUp.length === 0) return { ok: true }
    if (!this.deps.owner().rpc?.running) return { ok: false, error: pick('pi 尚未就绪，无法恢复排队消息', 'pi is not ready; cannot restore queued messages') }
    if (!this.isEmpty()) {
      const existing = {
        steering: this.state.steering.map((item) => item.text),
        followUp: this.state.followUp.map((item) => item.text)
      }
      if (JSON.stringify(existing) === JSON.stringify({ steering: snapshot.steering, followUp: snapshot.followUp }) &&
        KINDS.every(kind => this.state[kind].every((item, index) =>
          sameQueueImages(item.images, snapshot.items?.[kind][index]?.images)))) return { ok: true }
      return { ok: false, error: pick('新实例已有不同的排队消息；为避免丢失或重复，拒绝覆盖', 'The new instance already has different queued messages; overwrite refused to avoid loss or duplication') }
    }
    try {
      return await this.run(async () => {
        this.publishItems({ steering, followUp })
        await this.refill(steering, followUp)
        return { ok: true }
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  rewrite(next: QueueState): Promise<QueueRewriteResult> {
    return this.run(async () => {
      if (!this.deps.owner().rpc) return { ok: false, error: notReady(), dropped: [...next.steering, ...next.followUp] }
      return applyQueueRewrite(this.rewritePort(), this.copy(), next)
    })
  }

  edit(op: QueueEditOp): Promise<QueueRewriteResult> {
    return this.run(async () => {
      if (!this.deps.owner().rpc) return { ok: false, error: notReady() }
      const original = this.copy()
      const plan = planQueueEditOp(original, op)
      if ('error' in plan) return { ok: false, error: plan.error }
      return applyQueueRewrite(this.rewritePort(), original, plan.next)
    })
  }

  editItem(queueId: string, promote: boolean): Promise<EditResult> {
    return this.run(async () => {
      if (!this.deps.owner().rpc) return { ok: false, error: notReady() }
      const target = this.itemOf(queueId)
      if (!target) return { ok: false, error: pick('这条排队消息已被接收或撤回', 'This queued message was already accepted or withdrawn') }
      try {
        const res = await this.requireRpc().command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        this.requireRpc()
        if (!res.success) return { ok: false, error: res.error }
        const original = this.publish(res.data?.steering ?? [], res.data?.followUp ?? [], true)
        const liveTarget = original[target].find(item => item.id === queueId)
        if (!liveTarget) {
          const recovery = await this.restore(original)
          return { ok: false, error: recovery
            ? pick(`消息已被接收；恢复队列失败：${recovery}`, `Message was accepted; failed to restore the queue: ${recovery}`)
            : pick('消息已被 pi 接收（已进入本轮对话），无法再操作', 'pi already accepted this message (now in the turn); it can no longer be changed') }
        }
        const restSteer = original.steering.filter(item => item.id !== queueId)
        const restFollow = original.followUp.filter(item => item.id !== queueId)
        try {
          this.publishItems({ steering: promote ? [...restSteer, liveTarget] : restSteer, followUp: restFollow })
          await this.refill(restSteer, restFollow)
          if (promote) await this.refill([liveTarget], [])
          return promote ? { ok: true } : {
            ok: true, text: liveTarget.text, ...(liveTarget.images?.length ? { images: liveTarget.images } : {})
          }
        } catch (error) {
          const recovery = await this.restore(original)
          return { ok: false, error: recovery
            ? pick(`队列操作失败，且恢复原队列失败：${recovery}`, `Queue operation failed, and restoring the original queue failed: ${recovery}`)
            : pick(`队列操作失败，未消费内容已恢复：${error instanceof Error ? error.message : String(error)}`, `Queue operation failed; unconsumed content restored: ${error instanceof Error ? error.message : String(error)}`) }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  async clearForStop(): Promise<QueueSnapshot> {
    let cleared: QueueSnapshot = { steering: [], followUp: [] }
    await this.run(async () => {
      if (!this.deps.owner().rpc) return undefined
      const result = await this.requireRpc().command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
      this.requireRpc()
      if (result.success && result.data) {
        cleared = snapshotQueue(this.publish(result.data.steering ?? [], result.data.followUp ?? [], true))
        this.reset(true)
        this.clearSaved()
      }
      return result
    })
    return cleared
  }

  private copy(): QueueState {
    return { steering: [...this.state.steering], followUp: [...this.state.followUp] }
  }

  private newItem(text: string, images?: QueueImages): QueueItem {
    return { id: `q-${(++this.sequence).toString(36)}`, text,
      ...(images?.length ? { images: images.map(image => ({ ...image })) } : {}) }
  }

  private liveTexts(raw: string[], kind: QueueKind): string[] {
    let skip = this.consumedEmpty[kind]
    return raw.filter(text => text || skip-- <= 0)
  }

  private itemOf(id: string): QueueKind | undefined {
    if (!id) return undefined
    if (this.state.steering.some((item) => item.id === id)) return 'steering'
    return this.state.followUp.some((item) => item.id === id) ? 'followUp' : undefined
  }

  private persist(): Promise<void> {
    const sessionId = this.deps.owner().sessionId
    if (!sessionId) return Promise.resolve()
    const persisted = (items: QueueItem[]): PersistedQueueItem[] => items
      .filter(item => !isSubagentNotice(item.text) && (item.text.trim() || item.images?.length))
      .map(item => item.images?.length ? { text: item.text, images: item.images.map(({ data, mimeType }) => ({ data, mimeType })) } : { text: item.text })
    const steering = persisted(this.state.steering)
    const followUp = persisted(this.state.followUp)
    if (!steering.length && !followUp.length) return clearQueueFile(sessionId)
    return saveQueue({ sessionId, items: { steering, followUp } })
  }

  private async refill(steering: QueueItem[], followUp: QueueItem[]): Promise<void> {
    for (const [command, items] of [['steer', steering], ['follow_up', followUp]] as const) {
      for (const item of items) {
        if (this.consumed.has(item.id)) continue
        const res = await this.requireRpc().command(command, this.payload(item))
        this.requireRpc()
        if (!res.success) throw new Error(res.error || pick('恢复队列失败', 'Failed to restore the queue'))
      }
    }
  }

  private async restore(raw: QueueState): Promise<string | undefined> {
    if (!this.deps.owner().rpc) return pick('pi 尚未就绪，无法恢复排队消息', 'pi is not ready; cannot restore queued messages')
    try {
      const cleared = await this.requireRpc().command('clear_queue')
      this.requireRpc()
      if (!cleared.success) return cleared.error || pick('清空队列失败，无法恢复原顺序', 'Failed to clear the queue; cannot restore the original order')
      this.consumedEmpty = { steering: 0, followUp: 0 }
      const live = this.publishItems(raw)
      await this.refill(live.steering, live.followUp)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private rewritePort(): QueueRewritePort {
    return {
      clearQueue: async () => {
        const res = await this.requireRpc().command<{ steering?: string[]; followUp?: string[] }>('clear_queue')
        this.requireRpc()
        return { success: res.success, error: res.error, steering: res.data?.steering ?? [], followUp: res.data?.followUp ?? [] }
      },
      adoptCleared: (steering, followUp) => this.publish(steering, followUp, true),
      publish: (queue) => { this.publishItems(queue) },
      refill: (steering, followUp) => this.refill(steering, followUp)
    }
  }
}
