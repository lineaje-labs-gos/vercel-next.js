import {
  htmlEscapeAttributeString,
  htmlEscapeJsonString,
} from '../../shared/lib/htmlescape'
import {
  getTurbopackChunkGroupBootstrap,
  type BuildManifest,
} from '../get-page-files'
import { streamFromString } from '../stream-utils/node-web-streams-helper'

/**
 * Whether the Turbopack runtime's `<script>` tag can carry the chunk-group
 * bootstrap for a page with these root main files. The shared runtime chunk is
 * always the last root main file. Unless it's the only one, it's loaded with
 * `ReactDOM.preinit`, which can set data attributes on the tag (the first file
 * is React's bootstrap script, which can't).
 */
export function rootMainFilesCarryTurbopackBootstrap(
  rootMainFiles: readonly string[]
): boolean {
  return rootMainFiles.length > 1
}

/**
 * The Turbopack chunk-group bootstrap params for `pages`, as the JSON array the
 * Turbopack runtime reads from the `data-turbopack-bootstrap` attribute of its
 * own `<script>` tag (see `getRequiredScripts`). Returns undefined when the
 * build doesn't use the shared runtime, or has no params for `pages`.
 *
 * Unlike the inline bootstrap script, the attribute needs no CSP nonce and
 * carries only build-time data, so it can be part of a Cache Components static
 * shell.
 */
export function getTurbopackBootstrapData(
  buildManifest: BuildManifest,
  pages: readonly string[]
): string | undefined {
  if (
    !buildManifest.pagesChunkGroupBootstrapParams ||
    !buildManifest.chunkLoadingGlobal
  ) {
    return undefined
  }
  const paramsByPage = buildManifest.pagesChunkGroupBootstrapParams
  const params = pages.map((page) => paramsByPage[page]).filter(Boolean)
  return params.length > 0 ? JSON.stringify(params) : undefined
}

/**
 * Renders the Turbopack chunk-group bootstrap (see
 * `getTurbopackChunkGroupBootstrap`) as an inline `<script>` tag. This is only
 * the fallback for when the bootstrap can't be carried by the
 * `data-turbopack-bootstrap` attribute of the runtime's `<script>` tag (see
 * `getRequiredScripts`).
 *
 * Under Cache Components, a static shell is prerendered without a request, so
 * it can never carry the per-request CSP nonce. A static shell that is resumed
 * therefore leaves the bootstrap out, and the per-request resume emits it with
 * this helper instead, so that a nonce-based CSP allows it. The resume can't
 * add it to the shell, since on Vercel the shell is served before any Next.js
 * code runs. The shared runtime picks up a bootstrap pushed after it has
 * loaded: once it runs it replaces the queue with `{ push: registerChunk }`.
 * The entry's runtime modules can then be instantiated from within this inline
 * script, so they mustn't depend on `document.currentScript` being one of the
 * chunk scripts (see `appBootstrap`).
 */
export function getTurbopackBootstrapScriptTag(
  scriptContent: string,
  nonce: string | undefined
): string {
  const startScriptTag = nonce
    ? `<script nonce="${htmlEscapeAttributeString(nonce)}">`
    : '<script>'

  // The bootstrap is `globalThis[<JSON string>].push(<JSON params>)`: the only
  // characters that need escaping can only appear inside its JSON string
  // literals, where the `\uXXXX` escapes keep their value.
  return `${startScriptTag}${htmlEscapeJsonString(scriptContent)}</script>`
}

export function createTurbopackBootstrapScriptStream(
  scriptContent: string,
  nonce: string | undefined
): ReadableStream<Uint8Array> {
  return streamFromString(getTurbopackBootstrapScriptTag(scriptContent, nonce))
}

/**
 * The Turbopack bootstrap script for `page`, for serving a Cache Components
 * static shell on its own, without the resume that would otherwise emit it.
 * Returns undefined when the build doesn't inline a bootstrap for the page,
 * including when the runtime's `<script>` tag in the shell carries it.
 */
export function createTurbopackBootstrapScriptStreamForPage(
  buildManifest: BuildManifest,
  page: string,
  nonce: string | undefined
): ReadableStream<Uint8Array> | undefined {
  if (
    !buildManifest.pagesChunkGroupBootstrapParams ||
    !buildManifest.chunkLoadingGlobal ||
    rootMainFilesCarryTurbopackBootstrap(
      buildManifest.rootMainFilesTree?.[page] || buildManifest.rootMainFiles
    )
  ) {
    return undefined
  }
  const scriptContent = getTurbopackChunkGroupBootstrap(
    buildManifest.pagesChunkGroupBootstrapParams,
    buildManifest.chunkLoadingGlobal,
    [page]
  )
  return scriptContent
    ? createTurbopackBootstrapScriptStream(scriptContent, nonce)
    : undefined
}
