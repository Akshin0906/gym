import { Link } from 'react-router'
import { Home } from 'lucide-react'
import { Header } from '../components/Header'

export function NotFoundScreen() {
  return (
    <>
      <Header title="Not found" back="/" />
      <div className="px-4 py-8 max-w-md mx-auto">
        <section className="card p-6 text-center">
          <h2 className="text-xl font-bold leading-tight">
            This page does not exist.
          </h2>
          <p className="mt-2 text-sm text-[var(--color-fg-dim)]">
            The link may be old, or the workout data may have changed.
          </p>
          <Link to="/" className="btn-primary w-full mt-5 text-base">
            <Home size={18} />
            Go to Today
          </Link>
        </section>
      </div>
    </>
  )
}
