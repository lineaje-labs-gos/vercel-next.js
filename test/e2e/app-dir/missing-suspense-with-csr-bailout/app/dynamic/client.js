'use client'

import nextDynamic from 'next/dynamic'

const BrowserOnly = nextDynamic(() => import('./dynamic'), {
  ssr: false,
})

const BrowserOnlyWithLoading = nextDynamic(() => import('./dynamic'), {
  ssr: false,
  loading: () => <div id="loading-fallback">Loading...</div>,
})

export default function DynamicPage() {
  return (
    <>
      <div id="without-loading">
        <BrowserOnly id="browser-only">Browser only</BrowserOnly>
      </div>
      <div id="with-loading">
        <BrowserOnlyWithLoading id="browser-only-with-loading">
          Browser only with loading
        </BrowserOnlyWithLoading>
      </div>
    </>
  )
}
