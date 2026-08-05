import { lazy, Suspense } from 'react'
import { EagerClient } from './eager-client'

// Only reachable through an async import from a Server Component, so it must not be
// bundled into the chunks the page segment loads eagerly.
const LazyClient = lazy(() => import('./lazy-client'))

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ lazy?: string }>
}) {
  const { lazy: showLazy } = await searchParams
  return (
    <main>
      <p>hello world</p>
      <EagerClient />
      {showLazy ? (
        <Suspense fallback={null}>
          <LazyClient />
        </Suspense>
      ) : null}
    </main>
  )
}
