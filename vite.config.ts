import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Build-time release identity. Only a short commit marker and the package
// version are baked in — never a branch name, an author, or a path — so the
// Settings screen can identify the running build without leaking anything.
// Cloudflare Pages exposes CF_PAGES_COMMIT_SHA; a local build falls back to git
// and then to "unknown", which the UI renders as an explicit unavailable state.
function buildCommit(): string {
  const fromCi = process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA
  if (fromCi && /^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi.slice(0, 12)
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (/^[0-9a-f]{7,40}$/i.test(sha)) {
      const dirty = execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return dirty ? `${sha}+local` : sha
    }
  } catch {
    // Not a git checkout, or git is unavailable in the build image.
  }
  return 'unknown'
}

function packageVersion(): string {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
    )
    const version =
      raw !== null && typeof raw === 'object'
        ? (raw as { version?: unknown }).version
        : undefined
    return typeof version === 'string' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  define: {
    __APP_COMMIT__: JSON.stringify(buildCommit()),
    __APP_VERSION__: JSON.stringify(packageVersion()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icon.svg',
        'icon-maskable.svg',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-192.png',
        'icon-maskable-512.png',
        'apple-touch-icon.png',
      ],
      manifest: {
        id: '/',
        name: 'Workout Tracker',
        short_name: 'Workout',
        description: 'Hypertrophy workout tracker',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        categories: ['fitness', 'health', 'sports'],
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
})
