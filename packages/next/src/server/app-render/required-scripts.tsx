import { encodeURIPath } from '../../shared/lib/encode-uri-path'
import type { BuildManifest } from '../get-page-files'
import { rootMainFilesCarryTurbopackBootstrap } from './turbopack-bootstrap-script'

import ReactDOM from 'react-dom'

/**
 * The attribute the Turbopack runtime reads its chunk-group bootstrap params
 * from, on its own `<script>` tag (via `document.currentScript`).
 */
const TURBOPACK_BOOTSTRAP_ATTRIBUTE = 'data-turbopack-bootstrap'

/**
 * Returns the preinit callback for the root main files, the React bootstrap
 * script, and whether the Turbopack chunk-group bootstrap is carried by the
 * Turbopack runtime's `<script>` tag.
 *
 * `turbopackBootstrapData` is the JSON array of chunk-group bootstrap params
 * for the page (only set with Turbopack's shared runtime). The shared runtime
 * chunk is always the last root main file, so it's tagged with the
 * `data-turbopack-bootstrap` attribute when it is preinited. When it's the only
 * file, it's the React bootstrap script instead, which can't carry data
 * attributes, so the caller must fall back to an inline bootstrap script.
 */
export function getRequiredScripts(
  buildManifest: BuildManifest,
  assetPrefix: string,
  crossOrigin: undefined | '' | 'anonymous' | 'use-credentials',
  SRIManifest: undefined | Record<string, string>,
  qs: string,
  nonce: string | undefined,
  pagePath: string,
  turbopackBootstrapData?: string | undefined
): [
  () => void,
  { src: string; integrity?: string; crossOrigin?: string | undefined },
  boolean,
] {
  let preinitScripts: () => void
  let preinitScriptCommands: string[] = []
  const bootstrapScript: {
    src: string
    integrity?: string
    crossOrigin?: string | undefined
  } = {
    src: '',
    crossOrigin,
  }

  const files = (
    buildManifest.rootMainFilesTree?.[pagePath] || buildManifest.rootMainFiles
  ).map(encodeURIPath)
  if (files.length === 0) {
    throw new Error(
      'Invariant: missing bootstrap script. This is a bug in Next.js'
    )
  }

  const hasTurbopackBootstrapAttribute =
    turbopackBootstrapData !== undefined &&
    rootMainFilesCarryTurbopackBootstrap(files)
  const runtimeDataAttributes = hasTurbopackBootstrapAttribute
    ? { [TURBOPACK_BOOTSTRAP_ATTRIBUTE]: turbopackBootstrapData }
    : undefined
  const lastFileIndex = files.length - 1

  if (SRIManifest) {
    bootstrapScript.src = `${assetPrefix}/_next/` + files[0] + qs
    bootstrapScript.integrity = SRIManifest[files[0]]

    for (let i = 1; i < files.length; i++) {
      const src = `${assetPrefix}/_next/` + files[i] + qs
      const integrity = SRIManifest[files[i]]
      preinitScriptCommands.push(src, integrity)
    }
    preinitScripts = () => {
      // preinitScriptCommands is a double indexed array of src/integrity pairs
      for (let i = 0; i < preinitScriptCommands.length; i += 2) {
        ReactDOM.preinit(preinitScriptCommands[i], {
          as: 'script',
          integrity: preinitScriptCommands[i + 1],
          crossOrigin,
          nonce,
          // The commands start at file 1.
          dataAttributes:
            i / 2 + 1 === lastFileIndex ? runtimeDataAttributes : undefined,
        })
      }
    }
  } else {
    bootstrapScript.src = `${assetPrefix}/_next/` + files[0] + qs

    for (let i = 1; i < files.length; i++) {
      const src = `${assetPrefix}/_next/` + files[i] + qs
      preinitScriptCommands.push(src)
    }
    preinitScripts = () => {
      // preinitScriptCommands is a singled indexed array of src values
      for (let i = 0; i < preinitScriptCommands.length; i++) {
        ReactDOM.preinit(preinitScriptCommands[i], {
          as: 'script',
          nonce,
          crossOrigin,
          // The commands start at file 1.
          dataAttributes:
            i + 1 === lastFileIndex ? runtimeDataAttributes : undefined,
        })
      }
    }
  }

  return [preinitScripts, bootstrapScript, hasTurbopackBootstrapAttribute]
}
