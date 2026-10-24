import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@yan/design/index.css'
import '@yan/ui/ui.css'
import { App } from './App.tsx'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
