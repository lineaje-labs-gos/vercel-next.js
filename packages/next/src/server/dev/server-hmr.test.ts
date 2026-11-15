import type {
  ServerHmrLoadedState,
  ServerHmrUpdate,
  TurbopackResult,
} from '../../build/swc/types'
import { setupServerHmr } from './server-hmr'

type Version = { id: string }

function chunkVersion(path: string, id: string) {
  return { path, id, version: { id } as unknown as never }
}

function versionIds(state: ServerHmrLoadedState) {
  return state.chunks.map((version) => (version as unknown as Version).id)
}

/**
 * A fake project whose pulls are answered by the test: every pull records the
 * loaded state it was called with and waits for `respond`.
 */
function fakeProject() {
  const calls: {
    loaded: ServerHmrLoadedState
    entryPaths: string[]
    respond: (update: Partial<ServerHmrUpdate>) => void
  }[] = []
  const project = {
    getServerHmrUpdate(loaded: ServerHmrLoadedState, entryPaths: string[]) {
      return new Promise<TurbopackResult<ServerHmrUpdate>>((resolve) => {
        calls.push({
          loaded,
          entryPaths,
          respond: (update) =>
            resolve({
              issues: [],
              diagnostics: [],
              value: {
                kind: 'none',
                chunkVersions: [],
                applied: {} as never,
                installedChunks: [],
                ...update,
              } as ServerHmrUpdate,
            } as unknown as TurbopackResult<ServerHmrUpdate>),
        })
      })
    },
  }
  return { project, calls }
}

async function nextCall(calls: ReturnType<typeof fakeProject>['calls']) {
  for (let i = 0; i < 100 && calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  return calls.shift()!
}

const load = (chunkPath: string, versionId?: string) =>
  globalThis.__turbopack_on_chunk_loaded__!(chunkPath, versionId)

describe('setupServerHmr', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
    delete globalThis.__turbopack_server_hmr_handlers__
    delete globalThis.__turbopack_server_hmr_apply__
  })

  function setup() {
    const { project, calls } = fakeProject()
    const reEvaluate = jest.fn()
    const serverHmr = setupServerHmr(project as never, {
      reEvaluateAllModulesExpensive: reEvaluate,
      onApplied: () => {},
    })
    dispose = serverHmr.dispose
    return { serverHmr, calls, reEvaluate }
  }

  it('records the version a chunk reports, not the latest one', async () => {
    const { serverHmr, calls } = setup()

    let applied = serverHmr.apply(['route.js'])
    ;(await nextCall(calls)).respond({
      chunkVersions: [chunkVersion('server/chunks/a.js', 'a1')],
    })
    await applied

    applied = serverHmr.apply(['route.js'])
    ;(await nextCall(calls)).respond({
      chunkVersions: [chunkVersion('server/chunks/a.js', 'a2')],
    })
    await applied

    // The file that loads was written at the first version.
    load('server/chunks/a.js', 'a1')

    applied = serverHmr.apply(['route.js'])
    const call = await nextCall(calls)
    expect(versionIds(call.loaded)).toEqual(['a1'])
    expect(call.loaded.uncertainChunks).toEqual([])
    call.respond({ chunkVersions: [chunkVersion('server/chunks/a.js', 'a1')] })
    await applied
  })

  it('records a newer version that loads after a revert was reported', async () => {
    const { serverHmr, calls } = setup()

    for (const id of ['a1', 'a2', 'a1']) {
      const applied = serverHmr.apply(['route.js'])
      ;(await nextCall(calls)).respond({
        chunkVersions: [chunkVersion('server/chunks/a.js', id)],
      })
      await applied
    }
    // The file that loads was written at the second version, even though a
    // revert to the first one was reported last.
    load('server/chunks/a.js', 'a2')

    const applied = serverHmr.apply(['route.js'])
    const call = await nextCall(calls)
    expect(versionIds(call.loaded)).toEqual(['a2'])
    call.respond({})
    await applied
  })

  it('records chunks with an unknown or missing version as uncertain', async () => {
    const { serverHmr, calls } = setup()

    load('server/chunks/a.js', 'never-reported')
    load('server/chunks/b.js', undefined)

    const applied = serverHmr.apply(['route.js'])
    const call = await nextCall(calls)
    expect(call.loaded.chunks).toEqual([])
    expect(call.loaded.uncertainChunks).toEqual([
      'server/chunks/a.js',
      'server/chunks/b.js',
    ])
    call.respond({})
    await applied
  })

  it('forgets versions that are reported too long ago', async () => {
    const { serverHmr, calls } = setup()

    for (let i = 0; i < 9; i++) {
      const applied = serverHmr.apply(['route.js'])
      ;(await nextCall(calls)).respond({
        chunkVersions: [chunkVersion('server/chunks/a.js', `a${i}`)],
      })
      await applied
    }
    load('server/chunks/a.js', 'a0')

    const applied = serverHmr.apply(['route.js'])
    const call = await nextCall(calls)
    expect(call.loaded.chunks).toEqual([])
    expect(call.loaded.uncertainChunks).toEqual(['server/chunks/a.js'])
    call.respond({})
    await applied
  })

  it('keeps recently reported versions', async () => {
    const { serverHmr, calls } = setup()

    for (let i = 0; i < 9; i++) {
      const applied = serverHmr.apply(['route.js'])
      ;(await nextCall(calls)).respond({
        chunkVersions: [chunkVersion('server/chunks/a.js', `a${i}`)],
      })
      await applied
    }
    load('server/chunks/a.js', 'a1')

    const applied = serverHmr.apply(['route.js'])
    const call = await nextCall(calls)
    expect(versionIds(call.loaded)).toEqual(['a1'])
    expect(call.loaded.uncertainChunks).toEqual([])
    call.respond({})
    await applied
  })

  it('keeps the version of a chunk that loads while an update is computed', async () => {
    const { serverHmr, calls } = setup()

    let applied = serverHmr.apply(['route.js'])
    ;(await nextCall(calls)).respond({
      chunkVersions: [chunkVersion('server/chunks/a.js', 'a1')],
    })
    await applied

    applied = serverHmr.apply(['route.js'])
    const first = await nextCall(calls)
    // The chunk loads at the first version while the update is computed.
    load('server/chunks/a.js', 'a1')
    first.respond({ chunkVersions: [chunkVersion('server/chunks/a.js', 'a2')] })

    // The update didn't know about the chunk, so it is pulled again.
    const second = await nextCall(calls)
    expect(versionIds(second.loaded)).toEqual(['a1'])
    // After a revert, the chunk is still known to run the first version.
    second.respond({
      chunkVersions: [chunkVersion('server/chunks/a.js', 'a1')],
    })
    await applied

    applied = serverHmr.apply(['route.js'])
    const third = await nextCall(calls)
    expect(versionIds(third.loaded)).toEqual(['a1'])
    third.respond({})
    await applied
  })

  it('keeps a runtime replacement that happens while an update is computed', async () => {
    const { serverHmr, calls } = setup()

    globalThis.__turbopack_on_runtime_loaded__!('server/chunks')
    let applied = serverHmr.apply(['route.js'])
    const first = await nextCall(calls)
    expect(first.loaded.replacedRuntimeDirs).toEqual(['server/chunks'])
    // The runtime is replaced again before the update returns.
    globalThis.__turbopack_on_runtime_loaded__!('server/chunks')
    first.respond({})
    await applied

    applied = serverHmr.apply(['route.js'])
    const second = await nextCall(calls)
    expect(second.loaded.replacedRuntimeDirs).toEqual(['server/chunks'])
    second.respond({})
    await applied

    applied = serverHmr.apply(['route.js'])
    const third = await nextCall(calls)
    expect(third.loaded.replacedRuntimeDirs).toEqual([])
    third.respond({})
    await applied
  })

  it('restores the previous hooks when disposed', () => {
    const previous = () => {}
    globalThis.__turbopack_on_chunk_loaded__ = previous
    const { serverHmr } = setup()
    expect(globalThis.__turbopack_on_chunk_loaded__).not.toBe(previous)
    serverHmr.dispose()
    dispose = undefined
    expect(globalThis.__turbopack_on_chunk_loaded__).toBe(previous)
    delete globalThis.__turbopack_on_chunk_loaded__
  })
})
