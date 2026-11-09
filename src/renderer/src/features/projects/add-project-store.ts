import { create } from 'zustand'

export type AddProjectInitialView = 'root' | 'new'

interface AddProjectPaletteState {
  isOpen: boolean
  initialView: AddProjectInitialView
  open: (view?: AddProjectInitialView) => void
  close: () => void
  setOpen: (open: boolean) => void
}

export const useAddProjectPalette = create<AddProjectPaletteState>((set) => ({
  isOpen: false,
  initialView: 'root',
  open: (view = 'root') => set({ isOpen: true, initialView: view }),
  close: () => set({ isOpen: false }),
  setOpen: (open) => set({ isOpen: open })
}))
