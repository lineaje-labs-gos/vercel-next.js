import type {
  NodeJsPartialHmrUpdate,
  Project,
  ServerHmrApplied,
  ServerHmrChunkVersion,
} from '../../build/swc/types'

declare global {
  /**
   * Sync with `turbopack/crates/turbopack-ecmascript-runtime/js/src/nodejs/runtime/nodejs-globals.d.ts`.
   */
  var __turbopack_server_hmr_handlers__: Map<string, unknown> | undefined
  var __turbopack_server_hmr_apply__:
    | ((update: NodeJsPartialHmrUpdate) => void)
    | undefined
  var __turbopack_on_chunk_loaded__:
    | ((
        chunkPath: string,
        versionId: string | undefined
      ) => void | Promise<void>)
    | undefined
  var __turbopack_on_runtime_loaded__: ((chunkDir: string) => void) | undefined
}

/**
 * How often a server HMR update is pulled again because chunks loaded while it
 * was computed, before falling back to re-evaluating all modules.
 */
const MAX_SERVER_HMR_PULLS = 3

/**
 * How many reported versions of a chunk path are kept, so that a chunk that
 * loads a file written a few versions ago still finds its version. A chunk
 * whose version isn't known anymore counts as uncertain.
 */
const VERSIONS_PER_CHUNK = 8

/**
 * Collects the output chunk paths touched by a partial HMR update. Both
 * single-chunk `EcmascriptMergedUpdate`s and `ChunkListUpdate`s (which nest
 * per-chunk deltas inside `merged`) are flattened so the manifest cache can be
 * invalidated for every affected chunk after a successful apply.
 */
export function collectUpdatedChunkPaths(
  instruction: NodeJsPartialHmrUpdate['instruction']
): string[] {
  const paths = new Set<string>()
  if (instruction.type === 'EcmascriptMergedUpdate') {
    for (const chunkPath of Object.keys(instruction.chunks ?? {})) {
      paths.add(chunkPath)
    }
  } else if (instruction.type === 'ChunkListUpdate') {
    for (const chunkPath of Object.keys(instruction.chunks ?? {})) {
      paths.add(chunkPath)
    }
    for (const merged of instruction.merged ?? []) {
      for (const chunkPath of Object.keys(merged.chunks ?? {})) {
        paths.add(chunkPath)
      }
    }
  } else {
    throw new Error(
      `[Server HMR] unreachable: unknown HMR instruction type ${(instruction as { type: string }).type}`
    )
  }
  return Array.from(paths)
}

/** Whether `chunkPath` is a chunk directly inside `chunkDir`. */
function isInDir(chunkPath: string, chunkDir: string) {
  const prefix = chunkDir + '/'
  return (
    chunkPath.startsWith(prefix) &&
    !chunkPath.slice(prefix.length).includes('/')
  )
}

type Version = ServerHmrChunkVersion['version']

/**
 * Keeps the server runtimes up to date with the routes that run in them.
 *
 * Every route that runs in a server runtime shares its module cache, and a
 * chunk that loads keeps the factories the runtime already has. So updates are
 * computed against what the runtimes actually installed, not against what the
 * requested route saw before:
 * - Development chunks report the version id of their factories when they
 *   load. `versionsById` holds the versions Turbopack reported recently, so the
 *   version of a loaded chunk is known exactly.
 * - `loadedChunkVersions` holds the version of every chunk a runtime installed:
 *   the one it reported when it loaded, or the one an applied update brought it
 *   to.
 * - `uncertainChunks` holds chunks whose version isn't known, e.g. because it
 *   was never reported. They may have installed any module of their runtime
 *   directory at any code, until that runtime is replaced.
 * - `applied` holds the module hashes installed by applied updates, and
 *   `replacedRuntimeDirs` the generation of every directory whose runtime was
 *   replaced since, so that nothing applied to the old runtimes counts for the
 *   new ones.
 * - `routes` holds the chunks each route reported last, and `routesByChunk` the
 *   routes that ever reported a chunk. A dynamic import can still load a chunk
 *   its route no longer has, e.g. after the import's target was compiled on
 *   demand. Such a load waits for the route to be updated against what it
 *   installed before any of its modules is evaluated.
 */
export function setupServerHmr(
  project: Pick<Project, 'getServerHmrUpdate'>,
  {
    reEvaluateAllModulesExpensive,
    onApplied,
    mirrorApply,
  }: {
    reEvaluateAllModulesExpensive: () => void | Promise<void>
    onApplied: (chunkPaths: string[]) => void | Promise<void>
    /** Mirrors an applied update to other processes that run the modules. */
    mirrorApply?: (update: NodeJsPartialHmrUpdate) => void
  }
) {
  let pending = Promise.resolve()
  const versionsById = new Map<string, Version>()
  const versionIdsByChunk = new Map<string, string[]>()
  const loadedChunkVersions = new Map<string, Version>()
  const uncertainChunks = new Set<string>()
  let applied: ServerHmrApplied | undefined
  const replacedRuntimeDirs = new Map<string, number>()
  let runtimeGeneration = 0
  const routes = new Map<
    string,
    { entryPaths: string[]; chunks: Set<string> }
  >()
  const routesByChunk = new Map<string, Set<string>>()
  // Counts chunk loads, to detect loads that race with a pull.
  let chunkLoadCount = 0
  let needsReEvaluation = false

  function clearLoadedState() {
    loadedChunkVersions.clear()
    uncertainChunks.clear()
    applied = undefined
    replacedRuntimeDirs.clear()
  }

  function recordReportedVersion({ path, id, version }: ServerHmrChunkVersion) {
    let ids = versionIdsByChunk.get(path)
    if (!ids) {
      ids = []
      versionIdsByChunk.set(path, ids)
    }
    // A version reported again (e.g. after a revert) counts as recent again.
    const index = ids.indexOf(id)
    if (index !== -1) {
      ids.splice(index, 1)
    } else {
      versionsById.set(id, version)
    }
    ids.push(id)
    if (ids.length > VERSIONS_PER_CHUNK) {
      versionsById.delete(ids.shift()!)
    }
  }

  function routeKey(entryPaths: string[]) {
    return [...entryPaths].sort().join('\0')
  }

  function recordRouteChunks(entryPaths: string[], chunkPaths: string[]) {
    const key = routeKey(entryPaths)
    routes.set(key, { entryPaths, chunks: new Set(chunkPaths) })
    for (const chunkPath of chunkPaths) {
      let keys = routesByChunk.get(chunkPath)
      if (!keys) {
        keys = new Set()
        routesByChunk.set(chunkPath, keys)
      }
      keys.add(key)
    }
  }

  /** Routes that reported `chunkPath` before, but not in their last pull. */
  function routesThatDropped(chunkPath: string) {
    const keys = routesByChunk.get(chunkPath)
    if (!keys) return []
    return Array.from(keys)
      .map((key) => routes.get(key)!)
      .filter((route) => !route.chunks.has(chunkPath))
  }

  const previousOnChunkLoaded = globalThis.__turbopack_on_chunk_loaded__
  const previousOnRuntimeLoaded = globalThis.__turbopack_on_runtime_loaded__
  const onChunkLoaded = (
    chunkPath: string,
    versionId: string | undefined
  ): void | Promise<void> => {
    // Loading a chunk again (e.g. after `require.cache` was cleared for it)
    // doesn't replace the factories it installed before.
    if (loadedChunkVersions.has(chunkPath) || uncertainChunks.has(chunkPath)) {
      return
    }
    const version =
      versionId === undefined ? undefined : versionsById.get(versionId)
    if (version) {
      loadedChunkVersions.set(chunkPath, version)
    } else {
      uncertainChunks.add(chunkPath)
    }
    chunkLoadCount++

    const outdatedRoutes = routesThatDropped(chunkPath)
    if (outdatedRoutes.length === 0) return
    // The chunk is no longer part of these routes, so it may have installed
    // outdated factories, e.g. an inactive lazy-compilation proxy. Update the
    // routes before the load's modules are evaluated. Failures are handled by
    // `apply`, so they never reject the load.
    return Promise.all(
      outdatedRoutes.map((route) => apply(route.entryPaths))
    ).then(() => {})
  }
  const onRuntimeLoaded = (chunkDir: string) => {
    // A new runtime has none of the factories of the old one.
    for (const chunkPath of loadedChunkVersions.keys()) {
      if (isInDir(chunkPath, chunkDir)) {
        loadedChunkVersions.delete(chunkPath)
      }
    }
    for (const chunkPath of uncertainChunks) {
      if (isInDir(chunkPath, chunkDir)) {
        uncertainChunks.delete(chunkPath)
      }
    }
    replacedRuntimeDirs.set(chunkDir, ++runtimeGeneration)
  }
  globalThis.__turbopack_on_chunk_loaded__ = onChunkLoaded
  globalThis.__turbopack_on_runtime_loaded__ = onRuntimeLoaded

  function dispose() {
    if (globalThis.__turbopack_on_chunk_loaded__ === onChunkLoaded) {
      globalThis.__turbopack_on_chunk_loaded__ = previousOnChunkLoaded
    }
    if (globalThis.__turbopack_on_runtime_loaded__ === onRuntimeLoaded) {
      globalThis.__turbopack_on_runtime_loaded__ = previousOnRuntimeLoaded
    }
  }

  async function recover() {
    try {
      await reEvaluateAllModulesExpensive()
      clearLoadedState()
      needsReEvaluation = false
    } catch (error) {
      console.error('[Server HMR] Re-evaluating modules failed:', error)
    }
  }

  /**
   * Pulls the update for one entry against what the runtimes installed and
   * applies it. Returns `false` when the update could not be applied and all
   * modules need to be re-evaluated, `'stale'` when chunks loaded while the
   * update was computed, so it may miss modules they installed.
   */
  async function pull(entryPaths: string[]): Promise<boolean | 'stale'> {
    const loadedVersions = new Map(loadedChunkVersions)
    const runtimeDirsReplaced = new Map(replacedRuntimeDirs)
    const previousRouteChunks = routes.get(routeKey(entryPaths))?.chunks
    const chunkLoadCountBefore = chunkLoadCount
    // `issues` is intentionally dropped: this pull scans project-wide chunk
    // lists, so its issues may belong to an unrelated or removed route, and
    // endpoint writes already report route-scoped issues.
    const { value: update } = await project.getServerHmrUpdate(
      {
        chunks: Array.from(loadedVersions.values()),
        uncertainChunks: Array.from(uncertainChunks),
        applied,
        replacedRuntimeDirs: Array.from(runtimeDirsReplaced.keys()),
        previousRouteChunks: previousRouteChunks
          ? Array.from(previousRouteChunks)
          : undefined,
      },
      entryPaths
    )
    for (const chunkVersion of update.chunkVersions) {
      recordReportedVersion(chunkVersion)
    }
    const result = () =>
      chunkLoadCount === chunkLoadCountBefore ? true : 'stale'
    const advanceLoadedState = () => {
      recordRouteChunks(
        entryPaths,
        update.chunkVersions.map(({ path }) => path)
      )
      const installedChunks = new Set(update.installedChunks)
      // The update brought the chunks of the entry that were loaded when it
      // was computed up to date. Chunks that loaded since keep their version,
      // and uncertain chunks stay uncertain.
      for (const { path, version } of update.chunkVersions) {
        if (
          (loadedVersions.has(path) &&
            loadedChunkVersions.get(path) === loadedVersions.get(path)) ||
          (installedChunks.has(path) &&
            !loadedChunkVersions.has(path) &&
            !uncertainChunks.has(path))
        ) {
          loadedChunkVersions.set(path, version)
        }
      }
      applied = update.applied
      // Runtimes replaced while the update was computed keep their record.
      for (const [dir, generation] of runtimeDirsReplaced) {
        if (replacedRuntimeDirs.get(dir) === generation) {
          replacedRuntimeDirs.delete(dir)
        }
      }
      return result()
    }
    switch (update.kind) {
      case 'none':
        return advanceLoadedState()
      case 'partial': {
        const handlers = globalThis.__turbopack_server_hmr_handlers__
        // No runtime is loaded, so there is nothing to update.
        if (!handlers || handlers.size === 0) {
          recordRouteChunks(
            entryPaths,
            update.chunkVersions.map(({ path }) => path)
          )
          return result()
        }

        const payload: NodeJsPartialHmrUpdate = {
          type: 'partial',
          instruction: update.instruction,
        }
        const applyUpdate = globalThis.__turbopack_server_hmr_apply__
        if (typeof applyUpdate === 'function') {
          try {
            applyUpdate(payload)
            const pullResult = advanceLoadedState()
            mirrorApply?.(payload)

            const updatedChunkPaths = collectUpdatedChunkPaths(
              update.instruction
            )
            if (updatedChunkPaths.length > 0) {
              await onApplied(updatedChunkPaths)
            }
            return pullResult
          } catch {}
        }
        return false
      }
      default:
        throw new Error(
          `Unknown server HMR update kind: ${(update as { kind: string }).kind}`
        )
    }
  }

  function apply(entryPaths: string[]): Promise<void> {
    const applyPromise = pending.then(async () => {
      if (needsReEvaluation) {
        await recover()
        return
      }

      try {
        // Chunks that load while an update is computed may install outdated
        // modules it doesn't know of, so pull again until no chunk loads in
        // between.
        for (let attempt = 0; attempt < MAX_SERVER_HMR_PULLS; attempt++) {
          const result = await pull(entryPaths)
          if (result === true) return
          if (result === false) break
        }
      } catch (error) {
        console.error(
          '[Server HMR] Update failed, re-evaluating modules:',
          error
        )
      }

      needsReEvaluation = true
      await recover()
    })
    pending = applyPromise
    return applyPromise
  }

  function reset(): Promise<void> {
    const resetState = () => {
      clearLoadedState()
      needsReEvaluation = false
    }
    const resetPromise = pending.then(resetState, resetState)
    pending = resetPromise
    return resetPromise
  }

  return { apply, reset, dispose }
}
