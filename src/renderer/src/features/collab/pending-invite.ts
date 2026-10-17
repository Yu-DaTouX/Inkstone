import { create } from 'zustand'
import type { PairInvite } from '../../../../shared/pair-invite'

interface PendingPairInviteState {
  invite: PairInvite | null
  offer: (invite: PairInvite) => void
  take: () => PairInvite | null
}

export const usePendingPairInvite = create<PendingPairInviteState>((set, get) => ({
  invite: null,
  offer: (invite) => set({ invite: { ...invite } }),
  take: () => {
    const invite = get().invite
    if (invite) set({ invite: null })
    return invite
  }
}))
