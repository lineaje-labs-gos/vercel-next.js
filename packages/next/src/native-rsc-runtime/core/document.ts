// The Fizz half of the render, in the SSR bundles: decodes the route's Flight stream
// and renders it to HTML.

import { createElement, use, type ReactNode } from 'react'
// Fizz, from the vendored React that App Router loads: the renderer uses Next's copy of
// React, never the app's. `react` resolves to it in the SSR layer; `react-dom/server`
// doesn't (it maps to a separate compiled copy with its own React), so Fizz comes from
// the vendored module directly.
import { renderToReadableStream } from 'next/dist/server/route-modules/app-page/vendored/ssr/react-dom-server'
// eslint-disable-next-line import/no-extraneous-dependencies -- external (the precompile's EXTERNALS), resolved by the app's build
import { createFromReadableStream } from 'react-server-dom-webpack/client'
import type { RenderResult, RouteRenderer } from '../interface/renderer'
import type { FlightRenderer } from './flight'

export function createRouteRenderer(flight: FlightRenderer): RouteRenderer {
  return {
    renderDocument({ signal, reportError }): RenderResult {
      // When the client goes away, React reports the abort itself as an error. It isn't
      // one, so it's skipped: by name, as App Router does, and by identity with the
      // abort's reason, whatever it is.
      //
      // Flight serializes each error it reports with a digest, and Fizz rethrows it when
      // it decodes the stream. Fizz skips the errors Flight already reported, by digest,
      // so each is reported once, as the original. The digest is a per-render counter:
      // it doesn't reach the client yet.
      const flightErrorDigests = new Set<string>()
      // Flight aborts with Fizz's reason, or on its own once Fizz is done with it.
      const flightController = new AbortController()
      function reportFlightError(error: unknown): string | undefined {
        if (isAbort(error, flightController.signal)) return undefined
        const digest = String(flightErrorDigests.size + 1)
        flightErrorDigests.add(digest)
        reportError(error)
        return digest
      }
      function reportFizzError(error: unknown) {
        if (isAbort(error, signal)) return
        const digest = (error as { digest?: unknown } | null)?.digest
        if (typeof digest === 'string' && flightErrorDigests.has(digest)) return
        reportError(error)
      }
      // Flight aborts after Fizz. In the other order, Fizz would read Flight's abort as
      // an error in the stream and report it as a render error.
      const tree = createFromReadableStream<ReactNode>(
        flight.render({
          signal: flightController.signal,
          reportError: reportFlightError,
        }),
        {
          // No client components yet, so there's nothing to load.
          serverConsumerManifest: {
            moduleMap: {},
            serverModuleMap: null,
            moduleLoading: null,
          },
          findSourceMapURL: undefined,
        }
      )
      function Document() {
        return use(tree)
      }
      const html = renderToReadableStream(createElement(Document), {
        signal,
        onError: reportFizzError,
      })
      if (signal.aborted) {
        flightController.abort(signal.reason)
      } else {
        signal.addEventListener(
          'abort',
          () => flightController.abort(signal.reason),
          { once: true }
        )
      }

      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >()
      const head: RenderResult['head'] = html.then(
        (stream) => {
          // If the stream errors, `pipeTo` aborts `writable`, so `body` errors too, and
          // Flight, which nothing reads anymore, stops.
          stream.pipeTo(writable).catch(() => flightController.abort())
          return { outcome: { type: 'rendered' } }
        },
        () => {
          // The shell failed. `onError` already reported it, and nothing reads Flight
          // anymore, so it stops.
          flightController.abort()
          writable.close().catch(() => {})
          return { outcome: { type: 'error' } }
        }
      )
      return { head, body: readable }
    },
  }
}

// An abort through `signal`, with any reason, or one of the abort errors App Router's
// `isAbortError` matches: an `AbortError`, or the `ResponseAborted` a Node host aborts
// with when the client goes away.
function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted && error === signal.reason) return true
  if (typeof error !== 'object' || error === null) return false
  const { name } = error as { name?: unknown }
  return name === 'AbortError' || name === 'ResponseAborted'
}
