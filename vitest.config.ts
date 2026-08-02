import { defineConfig } from 'vitest/config'

// Standalone from vite.config.ts so tests don't load the React/PWA plugins.
// These are pure functions — no DOM needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
  },
})
