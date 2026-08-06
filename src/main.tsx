import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { seedIfEmpty } from './db/seed'
import { installCloudBriefingRefresh } from './lib/cloud'
import { autoRequestPersist } from './lib/storage'
import './index.css'

const PRELOAD_RELOAD_KEY = 'workout-preload-reload'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  if (sessionStorage.getItem(PRELOAD_RELOAD_KEY)) return
  sessionStorage.setItem(PRELOAD_RELOAD_KEY, '1')
  window.location.reload()
})
window.setTimeout(() => sessionStorage.removeItem(PRELOAD_RELOAD_KEY), 10_000)

// The generated worker claims open PWA windows immediately. Register through
// the update-aware client as well so an iOS standalone window reloads its
// in-memory JavaScript when that worker changes, rather than continuing to run
// a stale bundle after the new cache is active.
registerSW()

void (async () => {
  try {
    await seedIfEmpty()
  } catch (err) {
    console.error('Seed failed:', err)
  }
  // Ask the browser not to evict our IndexedDB. Fire-and-forget: silent on iOS
  // PWA / Chromium, never blocks render, and self-heals on later startups.
  void autoRequestPersist()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  installCloudBriefingRefresh()
})()
