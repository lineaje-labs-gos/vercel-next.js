/// <reference path="../../shared/runtime/runtime-types.d.ts" />

/**
 * Global type definitions for Node.js Turbopack runtime.
 * These properties are stored on globalThis to persist across chunk reloads during HMR.
 */

declare global {
  var __turbopack_module_factories__: ModuleFactories
  var __turbopack_module_cache__: Record<ModuleId, any>
  var __turbopack_runtime_modules__: Set<ModuleId>
  /**
   * Shared registry of per-runtime server HMR handler entries, keyed by the
   * runtime file's __filename. Map.set() naturally replaces stale entries when
   * a runtime file is re-evaluated. Reset to undefined by the hot-reloader on
   * full cache reset.
   */
  // NodeJsHmrPayload is only in scope inside the concatenated runtime chunk, not
  // in this .d.ts file, so the handler parameter must use any here.

  var __turbopack_server_hmr_handlers__:
    | Map<string, { handler: (update: any) => void; chunkPrefix: string }>
    | undefined
  /**
   * Compiles an on-demand chunk before the runtime requires it.
   *  Used together with EcmascriptOptionsContext.lazy_compilation
   */
  var __turbopack_ensure_chunk__:
    | ((chunkPath: ChunkPath) => void | Promise<void>)
    | undefined
  /**
   * Called synchronously when a runtime installed the factories of a chunk,
   * with the chunk's path relative to the output root and, for development
   * chunks, the version id of the chunk's factories. For async loads, a
   * returned promise is awaited before any module of the load is evaluated.
   */
  var __turbopack_on_chunk_loaded__:
    | ((
        chunkPath: ChunkPath,
        versionId: string | undefined
      ) => void | Promise<void>)
    | undefined
  /**
   * Called when a development runtime is evaluated, with the output directory
   * (relative to the output root) of the chunks it serves. A new runtime
   * starts without any installed factories.
   */
  var __turbopack_on_runtime_loaded__: ((chunkDir: string) => void) | undefined
}

export {}
