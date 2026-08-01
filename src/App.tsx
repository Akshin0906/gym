import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { TodayScreen } from './screens/TodayScreen'

// TodayScreen is the landing route — keep it eager so first paint never shows a
// Suspense fallback. Everything else is route-split: this pulls recharts (Stats +
// the active-workout exercise-detail overlay) and the heavier editors out of the
// initial bundle so the gym landing screen loads fast. Chunks are precached by
// the service worker, so offline navigation still works.
const LibraryScreen = lazy(() =>
  import('./screens/LibraryScreen').then((m) => ({ default: m.LibraryScreen })),
)
const ExerciseEditScreen = lazy(() =>
  import('./screens/ExerciseEditScreen').then((m) => ({
    default: m.ExerciseEditScreen,
  })),
)
const ActiveWorkoutScreen = lazy(() =>
  import('./screens/ActiveWorkoutScreen').then((m) => ({
    default: m.ActiveWorkoutScreen,
  })),
)
const HistoryScreen = lazy(() =>
  import('./screens/HistoryScreen').then((m) => ({ default: m.HistoryScreen })),
)
const SessionDetailScreen = lazy(() =>
  import('./screens/SessionDetailScreen').then((m) => ({
    default: m.SessionDetailScreen,
  })),
)
const ProgramsScreen = lazy(() =>
  import('./screens/ProgramsScreen').then((m) => ({
    default: m.ProgramsScreen,
  })),
)
const ProgramEditorScreen = lazy(() =>
  import('./screens/ProgramEditorScreen').then((m) => ({
    default: m.ProgramEditorScreen,
  })),
)
const SessionPreviewScreen = lazy(() =>
  import('./screens/SessionPreviewScreen').then((m) => ({
    default: m.SessionPreviewScreen,
  })),
)
const StatsScreen = lazy(() =>
  import('./screens/StatsScreen').then((m) => ({ default: m.StatsScreen })),
)
const SettingsScreen = lazy(() =>
  import('./screens/SettingsScreen').then((m) => ({
    default: m.SettingsScreen,
  })),
)
const AiMemoryScreen = lazy(() =>
  import('./screens/AiMemoryScreen').then((m) => ({
    default: m.AiMemoryScreen,
  })),
)
const CoachScreen = lazy(() =>
  import('./screens/CoachScreen').then((m) => ({
    default: m.CoachScreen,
  })),
)
const NotFoundScreen = lazy(() =>
  import('./screens/NotFoundScreen').then((m) => ({
    default: m.NotFoundScreen,
  })),
)

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<TodayScreen />} />
            <Route path="/library" element={<LibraryScreen />} />
            <Route path="/library/new" element={<ExerciseEditScreen />} />
            <Route path="/library/:id" element={<ExerciseEditScreen />} />
            <Route path="/programs" element={<ProgramsScreen />} />
            <Route path="/programs/:id" element={<ProgramEditorScreen />} />
            <Route path="/history" element={<HistoryScreen />} />
            <Route path="/history/:sessionId" element={<SessionDetailScreen />} />
            <Route path="/stats" element={<StatsScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="/settings/ai-memory" element={<AiMemoryScreen />} />
            <Route path="/coach" element={<CoachScreen />} />
            <Route path="/workout" element={<ActiveWorkoutScreen />} />
            <Route path="/preview/:templateId" element={<SessionPreviewScreen />} />
            <Route path="*" element={<NotFoundScreen />} />
          </Routes>
        </Suspense>
      </Layout>
    </BrowserRouter>
  )
}
