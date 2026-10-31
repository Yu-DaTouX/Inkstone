import { create } from 'zustand'

interface AddProjectPaletteState {
  isOpen: boolean
  open: () => void
  close: () => void
  setOpen: (open: boolean) => void
}

export const useAddProjectPalette = create<AddProjectPaletteState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setOpen: (open) => set({ isOpen: open })
}))
