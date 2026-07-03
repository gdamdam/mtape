import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
// Self-hosted faces (offline-safe, precached). Two deliberate machine-room voices:
//  - Saira Condensed: a technical condensed grotesque — the silkscreen lettering
//    stamped onto the deck faceplate: the MTAPE nameplate, channel numbers, and
//    section labels. Used tight and loud, sparingly.
//  - IBM Plex Mono: a grid-built technical monospace for every lit readout, meter
//    scale, tape counter, and number (dB / bars:beats / tempo).
import '@fontsource/saira-condensed/500.css'
import '@fontsource/saira-condensed/600.css'
import '@fontsource/saira-condensed/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './styles/global.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('mtape: #root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the service worker for offline support. Network-first navigation is
// handled inside the worker; failures here are non-fatal (e.g. unsupported, or
// blocked in private mode).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support unavailable — app still works online */
    })
  })
}
