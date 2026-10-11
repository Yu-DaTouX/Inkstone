import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { InteractionSession, useInteractionState } from '../../../src/renderer/src/lib/interaction-state'
import { WIDGET_STATE_BRIDGE } from '../../../src/renderer/src/lib/widget-state-bridge'

function Observer() {
  const state = useInteractionState()
  Object.assign(window, { observedInteraction: state })
  return <output>{state.session}: {state.ready ? 'ready' : state.error ?? 'loading'}</output>
}
function Harness() {
  const [session, setSession] = useState('A')
  Object.assign(window, { selectInteractionSession: setSession })
  return <InteractionSession.Provider value={session}><Observer /></InteractionSession.Provider>
}
createRoot(document.getElementById('root')!).render(<Harness />)
Object.assign(window, {
  mountBridge() {
    document.querySelector('iframe')?.remove()
    const frame = document.createElement('iframe')
    frame.sandbox.add('allow-scripts')
    frame.srcdoc = `<script>${WIDGET_STATE_BRIDGE}</script><input id="name" value="initial"><input id="secret" type="password" value="private"><select id="choices" multiple><option value="one" selected>one</option><option value="two">two</option></select><script>
      addEventListener('inkstone:restore', e => parent.postMessage({fixtureRestored: 1, custom: e.detail, value: document.querySelector('#name').value, selected: Array.from(document.querySelector('#choices').selectedOptions).map(o => o.value)}, '*'));
    </script>`
    document.body.appendChild(frame)
    return new Promise<void>(done => frame.addEventListener('load', () => done(), { once: true }))
  },
  captureBridge(request: string) {
    const frame = document.querySelector('iframe')!
    return new Promise<string>((done, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('capture timeout')) }, 3000)
      const listener = (event: MessageEvent) => {
        if (event.source === frame.contentWindow && event.data?.yanWidget === 1 && event.data.request === request) {
          cleanup(); done(event.data.text)
        }
      }
      const cleanup = () => { clearTimeout(timeout); removeEventListener('message', listener) }
      addEventListener('message', listener)
      frame.contentWindow!.postMessage({ yanWidgetState: 1, type: 'capture', request }, '*')
    })
  },
  restoreBridge(state: unknown) {
    const frame = document.querySelector('iframe')!
    return new Promise<unknown>((done, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('restore timeout')) }, 3000)
      const listener = (event: MessageEvent) => {
        if (event.source === frame.contentWindow && event.data?.fixtureRestored === 1) { cleanup(); done(event.data) }
      }
      const cleanup = () => { clearTimeout(timeout); removeEventListener('message', listener) }
      addEventListener('message', listener)
      frame.contentWindow!.postMessage({ yanWidgetState: 1, type: 'restore', state }, '*')
    })
  }
})
