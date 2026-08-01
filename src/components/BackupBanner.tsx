import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download } from 'lucide-react'
import {
  buildExportPayload,
  downloadExport,
} from '../db/repositories/exportImport'
import { countSessions, countSets } from '../db/repositories/sessions'
import {
  daysSince,
  getLastExportAt,
  markExportedNow,
  shouldRemindToBackup,
} from '../lib/backup'

export function BackupBanner() {
  const [show, setShow] = useState(false)
  const [lastExportAt, setLastExportAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const lea = getLastExportAt()
    const [setCount, sessionCount] = await Promise.all([
      countSets(),
      countSessions(),
    ])
    const hasAnyData = setCount > 0 || sessionCount > 0
    setLastExportAt(lea)
    setShow(shouldRemindToBackup(lea, hasAnyData))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleExport() {
    if (busy) return
    setBusy(true)
    try {
      const payload = await buildExportPayload()
      downloadExport(payload)
      markExportedNow()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!show) return null

  return (
    <div
      className="rounded-2xl p-4 flex items-start gap-3"
      style={{
        background: 'oklch(0.25 0.08 60 / 0.5)',
        border: '1px solid oklch(0.55 0.15 60 / 0.5)',
      }}
    >
      <AlertTriangle
        size={18}
        className="shrink-0 mt-0.5"
        style={{ color: 'var(--color-accent)' }}
      />
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-sm">
          {lastExportAt === null
            ? 'Back up your data'
            : `Last backup ${daysSince(lastExportAt)}d ago`}
        </h3>
        <p className="text-xs text-[var(--color-fg-dim)] mt-1 leading-relaxed">
          iOS evicts PWA storage after ~7 weeks of non-use. Export now to be
          safe.
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={busy}
          className="btn-primary text-sm py-2 px-3 mt-3"
        >
          <Download size={16} strokeWidth={2.25} />
          {busy ? 'Exporting…' : 'Export now'}
        </button>
      </div>
    </div>
  )
}
