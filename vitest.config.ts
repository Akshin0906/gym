import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Two environments on purpose.
//
// The bulk of the suite is pure functions and repository logic and runs in Node,
// which keeps it fast. Files ending in `.browser.test.tsx` render real
// components in jsdom, because a helper-only test cannot show that a screen
// actually resumes a workout, recovers from a failed read, or puts the primary
// action first.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'functions/**/*.test.ts'],
    // Browser files opt in with a `@vitest-environment jsdom` docblock.
    // A real origin is required: jsdom's default about:blank is an opaque
    // origin, and localStorage — which the cloud layer reads — is unavailable
    // there.
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: ['src/test/browserSetup.ts'],
  },
})
