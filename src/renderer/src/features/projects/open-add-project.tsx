import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '../../i18n'
import { AddProjectPalette } from './AddProjectPalette'
import { useAddProjectPalette, type AddProjectInitialView } from './add-project-store'

let root: Root | null = null
let generation = 0

export function openAddProjectPalette(view?: AddProjectInitialView): void {
  if (!root) {
    const host = document.createElement('div')
    host.setAttribute('data-add-project-host', '')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  root.render(
    <I18nProvider key={++generation}>
      <AddProjectPalette />
    </I18nProvider>
  )
  useAddProjectPalette.getState().open(view)
}
