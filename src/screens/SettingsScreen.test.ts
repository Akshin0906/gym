import { describe, expect, it } from 'vitest'
import type { CloudSyncStatus } from '../lib/cloud'
import { cloudBriefingErrorMessage } from './SettingsScreen'

const status: CloudSyncStatus = {
  lastSnapshotUploadAt: null,
  lastSnapshotUpdatedAt: null,
  lastSnapshotTrigger: null,
  lastSnapshotError: null,
  lastBriefingFetchAt: null,
  lastBriefingError: 'Network unavailable',
  lastMemoryFetchAt: null,
  lastMemoryError: null,
  lastMemorySummaryCount: null,
}

describe('cloud briefing diagnostics', () => {
  it('shows the saved fetch failure while the device is paired', () => {
    expect(cloudBriefingErrorMessage(true, status)).toBe(
      'Cloud briefing failed: Network unavailable',
    )
  })

  it('does not show stale cloud errors after the device is unpaired', () => {
    expect(cloudBriefingErrorMessage(false, status)).toBeNull()
  })
})
