import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

describe('missing-suspense-with-csr-bailout', () => {
  const { next, isNextDev, skipped } = nextTestSetup({
    files: __dirname,
    skipStart: true,
    // This test is skipped when deployed because it's not possible to rename files after deployment.
    skipDeployment: true,
  })

  if (skipped) {
    return
  }

  if (isNextDev) {
    it.skip('skip test for development mode', () => {})
    return
  }

  beforeEach(async () => {
    await next.clean()
  })

  const isCacheComponentsEnabled =
    process.env.__NEXT_CACHE_COMPONENTS === 'true'

  const bailoutImplementations = [
    {
      name: 'uses the legacy bailout by default',
      nextConfig: {},
      expectedDigest: 'BAILOUT_TO_CLIENT_SIDE_RENDERING',
    },
    {
      name: 'uses the React browser recoverable when enabled',
      nextConfig: { experimental: { reactBrowserBailout: true } },
      expectedDigest: '',
    },
  ]

  describe('useSearchParams', () => {
    const message = isCacheComponentsEnabled
      ? 'https://nextjs.org/docs/messages/blocking-prerender-client-hook'
      : `useSearchParams() should be wrapped in a suspense boundary at page "/".`

    it.each(bailoutImplementations)(
      '$name fails build if useSearchParams is not wrapped in a suspense boundary',
      async ({ nextConfig }) => {
        await next.patchFile(
          'next.config.js',
          `module.exports = ${JSON.stringify(nextConfig)}`,
          async () => {
            const { exitCode } = await next.build()
            expect(exitCode).toBe(1)
            expect(next.cliOutput).toContain(message)
            if (nextConfig.experimental?.reactBrowserBailout) {
              expect(next.cliOutput).not.toContain(
                'BAILOUT_TO_CLIENT_SIDE_RENDERING'
              )
            }
            // Can show the trace where the searchParams hook is used
            // TODO: This path is different for Turbopack. Builds need to have sourcemaps support.
            if (!process.env.IS_TURBOPACK_TEST) {
              expect(next.cliOutput).toMatch(/at.*server[\\/]app[\\/]page.js/)
            }
          }
        )
      }
    )

    it.each(bailoutImplementations)(
      '$name passes build if useSearchParams is wrapped in a suspense boundary',
      async ({ nextConfig }) => {
        await next.patchFile(
          'next.config.js',
          `module.exports = ${JSON.stringify(nextConfig)}`,
          async () => {
            await next.renameFile('app/layout.js', 'app/layout-no-suspense.js')
            await next.renameFile('app/layout-suspense.js', 'app/layout.js')

            await expect(next.build()).resolves.toEqual({
              exitCode: 0,
              cliOutput: expect.not.stringContaining(message),
            })

            await next.renameFile('app/layout.js', 'app/layout-suspense.js')
            await next.renameFile('app/layout-no-suspense.js', 'app/layout.js')
          }
        )
      }
    )
  })

  describe('next/dynamic', () => {
    const bailoutCases = [
      {
        container: '#without-loading',
        content: '#browser-only',
        serverFallback: '',
        clientContent: 'Browser only',
      },
      {
        container: '#with-loading',
        content: '#browser-only-with-loading',
        serverFallback: 'Loading...',
        clientContent: 'Browser only with loading',
      },
    ]

    it.each(bailoutImplementations)(
      '$name',
      async ({ nextConfig, expectedDigest }) => {
        await next.patchFile(
          'next.config.js',
          `module.exports = ${JSON.stringify(nextConfig)}`,
          async () => {
            await next.renameFile('app/page.js', 'app/_page.js')

            try {
              await next.start()

              const cliOutputIndex = next.cliOutput.length

              const $ = await next.render$('/dynamic')
              for (const {
                container,
                content,
                serverFallback,
              } of bailoutCases) {
                expect($(container).find(content)).toHaveLength(0)
                expect($(container).text()).toBe(serverFallback)
                expect(
                  $(container).find(`template[data-dgst="${expectedDigest}"]`)
                ).toHaveLength(1)
              }

              const browser = await next.browser('/dynamic', {
                pushErrorAsConsoleLog: true,
              })

              try {
                await retry(async () => {
                  for (const { content, clientContent } of bailoutCases) {
                    expect(await browser.elementByCss(content).text()).toBe(
                      clientContent
                    )
                  }
                })
                expect(
                  await browser.hasElementByCssSelector('#loading-fallback')
                ).toBe(false)
                expect(
                  (await browser.log()).filter((log) => log.source === 'error')
                ).toEqual([])
              } finally {
                await browser.close()
              }

              const cliOutput = next.cliOutput.slice(cliOutputIndex)
              expect(
                cliOutput.match(
                  /Recoverable Exception|Bail out to client-side rendering/
                )
              ).toBeNull()
            } finally {
              await next.stop()
              await next.renameFile('app/_page.js', 'app/page.js')
            }
          }
        )
      }
    )
  })
})
