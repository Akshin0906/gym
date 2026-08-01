import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { seedIfEmpty } from './db/seed'
import { installCloudBriefingRefresh } from './lib/cloud'
import { autoRequestPersist } from './lib/storage'
import './index.css'

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
