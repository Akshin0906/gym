import { lazy, Suspense } from 'react'
import {
  createBrowserRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom'
import { Layout } from './components/Layout'
import { RouteErrorBoundary, RouteLoading } from './components/RouteFeedback'
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
const ExerciseHistoryScreen = lazy(() =>
  import('./screens/ExerciseHistoryScreen').then((m) => ({
    default: m.ExerciseHistoryScreen,
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

function RoutedApp() {
  const { pathname } = useLocation()

  return (
    <Layout>
      <RouteErrorBoundary key={pathname}>
        <Suspense fallback={<RouteLoading />}>
          <Outlet />
        </Suspense>
      </RouteErrorBoundary>
    </Layout>
  )
}

const router = createBrowserRouter([
  {
    element: <RoutedApp />,
    children: [
      { path: '/', element: <TodayScreen /> },
      { path: '/library', element: <LibraryScreen /> },
      { path: '/library/new', element: <ExerciseEditScreen /> },
      {
        path: '/library/:id/history',
        element: <ExerciseHistoryScreen />,
      },
      { path: '/library/:id', element: <ExerciseEditScreen /> },
      { path: '/programs', element: <ProgramsScreen /> },
      { path: '/programs/:id', element: <ProgramEditorScreen /> },
      { path: '/history', element: <HistoryScreen /> },
      { path: '/history/:sessionId', element: <SessionDetailScreen /> },
      { path: '/stats', element: <StatsScreen /> },
      { path: '/settings', element: <SettingsScreen /> },
      { path: '/settings/ai-memory', element: <AiMemoryScreen /> },
      { path: '/coach', element: <CoachScreen /> },
      { path: '/workout', element: <ActiveWorkoutScreen /> },
      { path: '/preview/:templateId', element: <SessionPreviewScreen /> },
      { path: '*', element: <NotFoundScreen /> },
    ],
  },
])

export function App() {
  return <RouterProvider router={router} />
}
