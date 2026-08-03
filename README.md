# Gym

Gym is a mobile-first progressive web app for planning training, logging
workouts, reviewing progress, and getting context-aware coaching.

## Highlights

- Build an exercise library, training programs, sessions, and workout targets.
- Start workouts, log and edit sets, track rest, and review workout history and
  progress charts.
- Export and import workout data for portable backups.
- Pair a device with the cloud mirror for authenticated, conflict-safe sync.
- Connect Oura recovery data for recovery-aware daily insights when available.

## AI Coach

The in-app Coach is intentionally confirmation-gated: it can suggest a memory
note, program change, workout change, or custom exercise, but it cannot alter
training data silently. The phone validates and applies a proposal locally,
then synchronizes a durable receipt to the cloud.

The Coach backend uses a local Codex bridge and Cloudflare D1 as the canonical
transcript. It protects against duplicate work, stale snapshots, concurrent
device changes, retry replays, and interrupted bridge sessions. See
[automation/README.md](automation/README.md) for the daily-insight and Coach
bridge architecture.

## Stack

- React 19, TypeScript, Vite, Tailwind CSS, and React Router
- IndexedDB via Dexie for offline-first local workout data
- Cloudflare Pages Functions and D1 for cloud sync and Coach coordination
- Vitest for application and backend validation
- PWA support through `vite-plugin-pwa`

## Local development

Prerequisites: Node.js 20+ and npm.

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm test
npm run typecheck
npm run build
npx tsc -p tsconfig.functions.json --noEmit
```

## Cloud setup and deployment

The Pages/D1 configuration is in [wrangler.toml](wrangler.toml). Create the D1
database, update its ID in that file, then apply migrations:

```bash
npx wrangler d1 migrations apply workout-tracker --remote
```

Set these runtime secrets with Wrangler; never commit them:

```bash
npx wrangler pages secret put CLOUD_PAIRING_SECRET --project-name workout-tracker
npx wrangler pages secret put CLOUD_AUTOMATION_SECRET --project-name workout-tracker
```

Build and deploy:

```bash
npm run build
npx wrangler pages deploy dist --project-name workout-tracker --branch main
```

## Data and security notes

Local automation state, logs, environment files, and build output are excluded
from version control. Cloud writes use snapshot version checks, and AI action
receipts are verified before they become final. The local Codex bridge receives
no cloud secret and runs with constrained capabilities.

## License

No license has been selected yet. Until one is added, the repository's source
code is not licensed for third-party reuse.
