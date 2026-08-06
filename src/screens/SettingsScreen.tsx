import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  Activity,
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  Link as LinkIcon,
  Loader2,
  RefreshCw,
  Unlink,
  Upload,
} from 'lucide-react'
import { ErrorAlert, Toast, type ToastNotice } from '../components/Feedback'
import { Header } from '../components/Header'
import { ensureAiMemorySettings } from '../db/repositories/aiMemory'
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_SIZE_LABEL,
  buildExportPayload,
  downloadExport,
  importPayload,
} from '../db/repositories/exportImport'
import { markExportedNow } from '../lib/backup'
import {
  getCloudAuthStatus,
  getCloudSyncStatus,
  isCloudConfigured,
  pairCloudDevice,
  subscribeCloudSyncStatus,
  unpairCloudDevice,
  uploadCloudSnapshot,
  type CloudAuthStatus,
  type CloudSyncStatus,
} from '../lib/cloud'
import {
  formatBytes,
  getPersistStatus,
  getStorageUsage,
  requestPersist,
  type PersistStatus,
  type StorageUsage,
} from '../lib/storage'
import {
  beginOuraAuth,
  clearOuraToken,
  consumeOuraAuthRedirect,
  getDailyActivity,
  getDailyReadiness,
  getDailySleep,
  getOuraClientId,
  getOuraToken,
  getPersonalInfo,
  isOuraTokenExpired,
  ouraRedirectUri,
  setOuraClientId,
  ymd,
  type OuraPersonalInfo,
} from '../lib/oura'
import { useActiveWorkout } from '../store/activeWorkout'
import { useTimer } from '../store/timer'

const APP_RELEASE = '2026-08-06.2'

export function SettingsScreen() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<ToastNotice | null>(null)
  const [error, setError] = useState<string | null>(null)

  const showToast = useCallback((message: string) => {
    setToast((prev) => ({ id: (prev?.id ?? 0) + 1, message }))
  }, [])
  const dismissToast = useCallback(() => setToast(null), [])

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    setError(null)
    setToast(null)
    try {
      const payload = await buildExportPayload()
      downloadExport(payload)
      markExportedNow()
      const c = payload.data
      showToast(
        `Exported ${c.exercises.length} exercises, ${c.workoutSessions.length} sessions, ${c.loggedSets.length} sets, ${c.aiNotes.length} AI notes, ${c.aiMemorySummaries.length} summaries.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  async function handleImportFile(file: File) {
    if (importing) return
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`Import file must be ${MAX_IMPORT_SIZE_LABEL} or smaller`)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    if (
      !confirm(
        'This will REPLACE all current data. A backup of your current data will download first. Continue?',
      )
    )
      return
    setImporting(true)
    setError(null)
    setToast(null)
    try {
      const backup = await buildExportPayload()
      downloadExport(backup)
      markExportedNow()
      const text = await file.text()
      const result = await importPayload(text)
      useActiveWorkout.getState().setActiveSession(null)
      useTimer.getState().stop()
      const totals = Object.entries(result.imported)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ')
      showToast(`Import complete: ${totals}. Returning to Today…`)
      window.setTimeout(() => navigate('/', { replace: true }), 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <>
      <Header title="Settings" back />
      <div className="px-4 py-5 space-y-6 max-w-md mx-auto">
        <section className="space-y-2">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            AI
          </h2>
          <AiMemorySettingsLink />
        </section>

        <CloudSyncSection onSynced={showToast} />

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Backup
          </h2>
          <p className="text-sm text-[var(--color-fg-dim)]">
            iOS evicts PWA storage after ~7 weeks of non-use. Export regularly.
          </p>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting}
            className="btn-primary w-full py-3 text-base"
          >
            <Download size={18} strokeWidth={2.25} />
            {exporting ? 'Exporting…' : 'Export all data'}
          </button>
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Restore
          </h2>
          <p className="text-sm text-[var(--color-fg-dim)]">
            Import a previous export.{' '}
            <strong className="text-[var(--color-fg)]">Replaces</strong> all
            current data. A backup downloads first automatically.
          </p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="btn-secondary w-full py-3 text-base"
          >
            <Upload size={18} strokeWidth={2.25} />
            {importing ? 'Importing…' : 'Choose file…'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label="Choose workout backup JSON file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImportFile(file)
            }}
          />
        </section>

        {error && <ErrorAlert message={error} />}

        <StorageSection />

        <OuraSection />

        <section className="pt-4 border-t border-[var(--color-border)] text-xs text-[var(--color-fg-faint)]">
          <p>Workout Tracker · v0.1.0 · release {APP_RELEASE}</p>
          <p className="mt-1">
            IndexedDB primary · cloud snapshot when synced.
          </p>
        </section>
      </div>
      <Toast notice={toast} onDismiss={dismissToast} />
    </>
  )
}

function formatDateTime(epochMs: number | null): string {
  if (epochMs === null) return 'Never'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(epochMs)
}

function CloudSyncSection({
  onSynced,
}: {
  onSynced: (message: string) => void
}) {
  const [status, setStatus] = useState<CloudSyncStatus>(() =>
    getCloudSyncStatus(),
  )
  const [auth, setAuth] = useState<CloudAuthStatus>(() => ({
    paired: isCloudConfigured(),
    device: null,
  }))
  const [syncing, setSyncing] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(false)
  const checkingAuthRef = useRef(false)
  const [pairing, setPairing] = useState(false)
  const [unpairing, setUnpairing] = useState(false)
  const [pairingSecret, setPairingSecret] = useState('')
  const [deviceName, setDeviceName] = useState('Phone PWA')
  const [authError, setAuthError] = useState<string | null>(null)
  const configured = auth.paired

  const refreshAuth = useCallback(async () => {
    if (checkingAuthRef.current) return
    checkingAuthRef.current = true
    setCheckingAuth(true)
    try {
      setAuth(await getCloudAuthStatus())
      setAuthError(null)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      checkingAuthRef.current = false
      setCheckingAuth(false)
    }
  }, [])

  useEffect(() => {
    void refreshAuth()
    return subscribeCloudSyncStatus(() => {
      setStatus(getCloudSyncStatus())
      setAuth((prev) => {
        const paired = isCloudConfigured()
        if (prev.paired === paired) return prev
        return { paired, device: paired ? prev.device : null }
      })
    })
  }, [refreshAuth])

  async function handlePair() {
    if (pairing) return
    const secret = pairingSecret.trim()
    if (!secret) {
      setAuthError('Pairing code is required.')
      return
    }
    setPairing(true)
    setAuthError(null)
    try {
      const next = await pairCloudDevice(secret, deviceName.trim())
      setAuth(next)
      setPairingSecret('')
      onSynced('Cloud device paired.')
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setPairing(false)
    }
  }

  async function handleUnpair() {
    if (unpairing) return
    setUnpairing(true)
    setAuthError(null)
    try {
      await unpairCloudDevice()
      setAuth({ paired: false, device: null })
      onSynced('Cloud device signed out.')
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setUnpairing(false)
    }
  }

  async function handleSyncNow() {
    if (syncing || !configured) return
    setSyncing(true)
    try {
      await uploadCloudSnapshot('manual')
      setStatus(getCloudSyncStatus())
      onSynced('Cloud snapshot uploaded.')
    } catch {
      setStatus(getCloudSyncStatus())
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
        Cloud
      </h2>
      <div className="card-tight px-3 py-3 flex items-center gap-3">
        <Cloud size={18} className="shrink-0 text-[var(--color-accent)]" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">
            {configured ? 'Cloud sync paired' : 'Cloud sync not paired'}
          </div>
          <div className="text-xs text-[var(--color-fg-faint)] mt-0.5">
            {configured
              ? `Device: ${auth.device?.name ?? 'This device'}`
              : checkingAuth
                ? 'Checking device session'
                : 'Pair once, then stay signed in'}
          </div>
          <div className="text-xs text-[var(--color-fg-faint)] mt-0.5 nums">
            Snapshot: {formatDateTime(status.lastSnapshotUploadAt)}
          </div>
          <div className="text-xs text-[var(--color-fg-faint)] mt-0.5 nums">
            Briefing check: {formatDateTime(status.lastBriefingFetchAt)}
          </div>
          <div className="text-xs text-[var(--color-fg-faint)] mt-0.5 nums">
            Memory check: {formatDateTime(status.lastMemoryFetchAt)}
            {status.lastMemorySummaryCount !== null
              ? ` · ${status.lastMemorySummaryCount} summaries`
              : ''}
          </div>
        </div>
      </div>
      {!configured ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void handlePair()
          }}
        >
          <label htmlFor="cloud-pairing-code" className="sr-only">
            Cloud pairing code
          </label>
          <input
            id="cloud-pairing-code"
            type="password"
            autoComplete="one-time-code"
            value={pairingSecret}
            onChange={(e) => setPairingSecret(e.target.value)}
            placeholder="Pairing code"
            className="field font-mono"
          />
          <label htmlFor="cloud-device-name" className="sr-only">
            Device name
          </label>
          <input
            id="cloud-device-name"
            type="text"
            autoComplete="off"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Device name"
            className="field"
          />
          <button
            type="submit"
            disabled={pairing || !pairingSecret.trim()}
            className="btn-primary w-full py-2.5 text-sm"
          >
            {pairing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <LinkIcon size={16} />
            )}
            {pairing ? 'Pairing…' : 'Pair device'}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => void handleUnpair()}
          disabled={unpairing}
          className="btn-secondary w-full py-2.5 text-sm"
        >
          {unpairing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Unlink size={16} />
          )}
          {unpairing ? 'Signing out…' : 'Sign out this device'}
        </button>
      )}
      <button
        type="button"
        onClick={() => void handleSyncNow()}
        disabled={!configured || syncing}
        className="btn-secondary w-full py-2.5 text-sm"
      >
        {syncing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <RefreshCw size={16} />
        )}
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
      {configured && status.lastSnapshotError && (
        <ErrorAlert message={`Cloud sync failed: ${status.lastSnapshotError}`} />
      )}
      {configured && status.lastMemoryError && (
        <ErrorAlert message={`Cloud memory failed: ${status.lastMemoryError}`} />
      )}
      {authError && <ErrorAlert message={authError} />}
    </section>
  )
}

function AiMemorySettingsLink() {
  const [status, setStatus] = useState<string>('Checking...')

  useEffect(() => {
    let cancelled = false
    void ensureAiMemorySettings()
      .then((settings) => {
        if (!cancelled) setStatus(settings.paused ? 'Stopped' : 'Running')
      })
      .catch(() => {
        if (!cancelled) setStatus('Unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Link
      to="/settings/ai-memory"
      className="card-tight px-3 py-3 flex items-center gap-3 hover:bg-[var(--color-surface-2)] transition-colors"
    >
      <Brain size={18} className="shrink-0 text-[var(--color-accent)]" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold">AI Memory</div>
        <div className="text-xs text-[var(--color-fg-faint)] mt-0.5">
          Global context, notes, summaries
        </div>
      </div>
      <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
        {status}
      </span>
      <ChevronRight
        size={16}
        className="shrink-0 text-[var(--color-fg-faint)]"
      />
    </Link>
  )
}

function StorageSection() {
  const [status, setStatus] = useState<PersistStatus | null>(null)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [requestResult, setRequestResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([getPersistStatus(), getStorageUsage()])
      setStatus(s)
      setUsage(u)
    } catch (caught) {
      setStatus('unsupported')
      setRequestResult(
        caught instanceof Error ? caught.message : String(caught),
      )
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleRequest() {
    if (busy) return
    setBusy(true)
    try {
      const next = await requestPersist()
      setStatus(next)
      setRequestResult(
        next === 'persisted'
          ? 'Persistent storage was granted.'
          : next === 'transient'
            ? 'The browser did not grant persistent storage. Keep exporting backups regularly.'
            : 'Persistent storage is not available in this browser.',
      )
    } finally {
      setBusy(false)
    }
  }

  const usageLabel =
    usage && usage.usageBytes !== null
      ? usage.quotaBytes !== null && usage.quotaBytes > 0
        ? `Using ${formatBytes(usage.usageBytes)} of ${formatBytes(usage.quotaBytes)} available`
        : `Using ${formatBytes(usage.usageBytes)}`
      : null

  return (
    <section className="space-y-3 pt-4 border-t border-[var(--color-border)]">
      <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
        Storage
      </h2>
      {status === null ? (
        <p className="text-sm text-[var(--color-fg-faint)]">Checking…</p>
      ) : (
        <>
          <div className="card-tight px-3 py-2.5 flex gap-2 text-sm">
            {status === 'persisted' ? (
              <CheckCircle2
                size={16}
                className="shrink-0 mt-0.5"
                style={{ color: 'var(--color-accent)' }}
              />
            ) : (
              <AlertCircle
                size={16}
                className="shrink-0 mt-0.5 text-[var(--color-fg-faint)]"
              />
            )}
            <div className="min-w-0">
              <div className="font-semibold">
                {status === 'persisted'
                  ? 'Persistent — protected from eviction'
                  : status === 'transient'
                    ? 'Best-effort — can be evicted'
                    : 'Not available on this browser'}
              </div>
              <p className="text-xs text-[var(--color-fg-faint)] mt-0.5 leading-relaxed">
                {status === 'persisted'
                  ? "The browser agreed not to clear this app's data to reclaim space. Keep exporting anyway — that's the only recovery if the app is deleted or you clear site data."
                  : status === 'transient'
                    ? 'iOS may clear this data under storage pressure or after long disuse. Adding the app to your Home Screen makes a persistence grant far more likely.'
                    : 'Persistent storage needs iOS 17+ / Safari 17+. Regular exports are your only safeguard here.'}
              </p>
            </div>
          </div>
          {status === 'transient' && (
            <button
              type="button"
              onClick={() => void handleRequest()}
              disabled={busy}
              className="btn-secondary w-full py-2.5 text-sm"
            >
              {busy ? 'Requesting…' : 'Request persistent storage'}
            </button>
          )}
          {usageLabel && (
            <p className="text-xs text-[var(--color-fg-faint)] px-1 nums">
              {usageLabel}
            </p>
          )}
          {requestResult && (
            <p role="status" className="text-sm text-[var(--color-fg-dim)] px-1">
              {requestResult}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function OuraSection() {
  const [clientIdInput, setClientIdInput] = useState('')
  const [clientId, setClientId] = useState<string | null>(() => getOuraClientId())
  const [connected, setConnected] = useState(
    () => !!getOuraToken() && !isOuraTokenExpired(),
  )
  const [info, setInfo] = useState<OuraPersonalInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  // Handle OAuth redirect callback (runs once on mount).
  useEffect(() => {
    const result = consumeOuraAuthRedirect()
    if (!result) return
    if (result.ok) {
      setConnected(true)
    } else if (result.error) {
      setError(result.error)
    }
  }, [])

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void getPersonalInfo()
      .then((res) => {
        if (!cancelled) setInfo(res)
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [connected])

  function handleSaveClientId() {
    const id = clientIdInput.trim()
    if (!id) return
    setOuraClientId(id)
    setClientId(id)
    setClientIdInput('')
  }

  function handleConnect() {
    if (!clientId) return
    setError(null)
    beginOuraAuth(clientId)
  }

  async function handleCopyRedirectUri() {
    try {
      await navigator.clipboard.writeText(ouraRedirectUri())
    } catch {
      // user can still read & copy manually
    }
  }

  async function handleTest() {
    if (busy) return
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 6)
      const [sleep, readiness, activity] = await Promise.all([
        getDailySleep(ymd(start), ymd(end)),
        getDailyReadiness(ymd(start), ymd(end)),
        getDailyActivity(ymd(start), ymd(end)),
      ])
      const lastSleep = sleep[sleep.length - 1]
      const lastReadiness = readiness[readiness.length - 1]
      const lastActivity = activity[activity.length - 1]
      const lines = [
        `${sleep.length} sleep · ${readiness.length} readiness · ${activity.length} activity`,
      ]
      if (lastSleep)
        lines.push(`Last sleep score (${lastSleep.day}): ${lastSleep.score ?? '—'}`)
      if (lastReadiness)
        lines.push(
          `Last readiness (${lastReadiness.day}): ${lastReadiness.score ?? '—'}`,
        )
      if (lastActivity)
        lines.push(
          `Last steps (${lastActivity.day}): ${lastActivity.steps ?? '—'}`,
        )
      setTestResult(lines.join('\n'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function handleDisconnect() {
    clearOuraToken()
    setConnected(false)
    setInfo(null)
    setTestResult(null)
    setError(null)
  }

  function handleResetSetup() {
    if (!confirm('Forget the Oura Client ID? You’ll need to paste it again to reconnect.')) return
    clearOuraToken()
    setOuraClientId(null)
    setClientId(null)
    setConnected(false)
    setInfo(null)
    setTestResult(null)
    setError(null)
  }

  // Three discrete UI states; render one per branch instead of nesting ternaries.
  let body: React.ReactNode
  if (connected) {
    body = (
      <ConnectedBody
        info={info}
        busy={busy}
        testResult={testResult}
        onTest={() => void handleTest()}
        onDisconnect={handleDisconnect}
      />
    )
  } else if (clientId) {
    body = (
      <ReadyToConnectBody
        busy={busy}
        onConnect={handleConnect}
        onReset={handleResetSetup}
      />
    )
  } else {
    body = (
      <SetupBody
        clientIdInput={clientIdInput}
        onChangeInput={setClientIdInput}
        onSave={handleSaveClientId}
        onCopyRedirect={() => void handleCopyRedirectUri()}
      />
    )
  }

  return (
    <section className="space-y-3 pt-4 border-t border-[var(--color-border)]">
      <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
        Oura
      </h2>
      {body}
      {error && <ErrorAlert message={error} />}
    </section>
  )
}

function SetupBody({
  clientIdInput,
  onChangeInput,
  onSave,
  onCopyRedirect,
}: {
  clientIdInput: string
  onChangeInput: (s: string) => void
  onSave: () => void
  onCopyRedirect: () => void
}) {
  return (
    <>
      <p className="text-sm text-[var(--color-fg-dim)]">
        Pull sleep, readiness, and activity from your Oura ring. First,
        register an OAuth app at{' '}
        <span className="text-[var(--color-fg)]">cloud.ouraring.com</span> → API
        Applications. Use this exact redirect URI:
      </p>
      <button
        type="button"
        onClick={onCopyRedirect}
        className="card-tight w-full px-3 py-2.5 flex items-center gap-2 text-xs text-left font-mono hover:bg-[var(--color-surface-2)]"
      >
        <span className="flex-1 truncate text-[var(--color-fg)]">
          {ouraRedirectUri()}
        </span>
        <Copy size={14} className="shrink-0 text-[var(--color-fg-faint)]" />
      </button>
      <p className="text-sm text-[var(--color-fg-dim)]">
        Then paste the Client ID from your app below.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSave()
        }}
        className="space-y-2"
      >
        <label htmlFor="oura-client-id" className="sr-only">
          Oura Client ID
        </label>
        <input
          id="oura-client-id"
          type="text"
          autoComplete="off"
          value={clientIdInput}
          onChange={(e) => onChangeInput(e.target.value)}
          placeholder="Client ID"
          className="field font-mono"
        />
        <button
          type="submit"
          disabled={!clientIdInput.trim()}
          className="btn-secondary w-full py-2.5 text-sm"
        >
          Save Client ID
        </button>
      </form>
    </>
  )
}

function ReadyToConnectBody({
  busy,
  onConnect,
  onReset,
}: {
  busy: boolean
  onConnect: () => void
  onReset: () => void
}) {
  return (
    <>
      <p className="text-sm text-[var(--color-fg-dim)]">
        Client ID saved. Tap connect to authorize on Oura — you’ll bounce out,
        approve, and come back.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="btn-primary w-full py-3 text-base"
      >
        <LinkIcon size={18} strokeWidth={2.25} />
        Connect Oura
      </button>
      <button
        type="button"
        onClick={onReset}
        className="btn-ghost text-xs w-full justify-center"
      >
        Reset setup
      </button>
    </>
  )
}

function ConnectedBody({
  info,
  busy,
  testResult,
  onTest,
  onDisconnect,
}: {
  info: OuraPersonalInfo | null
  busy: boolean
  testResult: string | null
  onTest: () => void
  onDisconnect: () => void
}) {
  return (
    <>
      <div className="card-tight px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <Activity
            size={16}
            className="text-[var(--color-accent)] shrink-0"
          />
          <span className="font-semibold flex-1 truncate">
            {info?.email ?? 'Connected'}
          </span>
        </div>
        {info && (info.age || info.biological_sex) && (
          <div className="text-xs text-[var(--color-fg-faint)] mt-1 nums">
            {[info.age && `age ${info.age}`, info.biological_sex]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onTest}
          disabled={busy}
          className="btn-secondary flex-1 text-sm"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          Pull last 7 days
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          className="btn-ghost text-sm"
        >
          <Unlink size={14} /> Disconnect
        </button>
      </div>
      {testResult && (
        <pre className="card-tight px-3 py-2 text-xs text-[var(--color-fg-dim)] whitespace-pre-wrap font-mono">
          {testResult}
        </pre>
      )}
    </>
  )
}
