import { Suspense, type ReactNode } from 'react'
import { connection } from 'next/server'
import { BrowserOnly } from './client'

// Make sure that the hole from this layout isn't factored in for validation
// (otherwise, we'd check a navigation into it from the root layout and fail)
export const instant = false

export default async function Layout({ children }: { children: ReactNode }) {
  await connection() // Prevent the browser bailout from failing the prerender in build
  return (
    <Suspense fallback={null}>
      <BrowserOnly>{children}</BrowserOnly>
    </Suspense>
  )
}
