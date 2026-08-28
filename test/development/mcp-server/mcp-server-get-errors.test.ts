import { FileRef, nextTestSetup } from 'e2e-utils'
import path from 'path'
import { retry, debugPrint, getFullUrl } from 'next-test-utils'
import stripAnsi from 'strip-ansi'
import { chromium, firefox, webkit } from 'playwright'
import type { Browser } from 'playwright'

describe('mcp-server get_errors tool', () => {
  const { next } = nextTestSetup({
    files: new FileRef(path.join(__dirname, 'fixtures', 'default-template')),
  })

  async function callGetErrors(id: string) {
    const response = await fetch(`${next.url}/_next/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'get_errors', arguments: {} },
      }),
    })

    const text = await response.text()
    const match = text.match(/data: ({.*})/s)
    const result = JSON.parse(match![1])
    return result.result?.content?.[0]?.text
  }

  async function waitForRuntimeError({
    url,
    message,
    type = 'runtime',
    isFatal,
  }: {
    url: string
    message?: string
    type?: 'runtime' | 'recoverable' | 'console'
    isFatal: boolean
  }) {
    let runtimeError: any = null

    await retry(async () => {
      const errorsText = await callGetErrors(`test-runtime-${Date.now()}`)
      const errors = JSON.parse(errorsText)
      const session = errors.sessionErrors.find(
        (entry: any) => entry.url === url
      )
      expect(session).toBeDefined()
      runtimeError = session.runtimeErrors.find((error: any) =>
        message ? error.message === message : error.type === type
      )
      expect(runtimeError).toMatchObject({
        type,
        isFatal,
        ...(message ? { message } : {}),
      })
    })

    return runtimeError
  }

  it('should handle no browser sessions gracefully', async () => {
    const errorsText = await callGetErrors('test-no-session')
    const errors = JSON.parse(errorsText)
    expect(errors).toMatchInlineSnapshot(`
      {
        "error": "No browser sessions connected. Please open your application in a browser to retrieve error state.",
      }
    `)
  })

  it('should return no errors for clean page', async () => {
    await next.browser('/')
    const errorsText = await callGetErrors('test-1')
    const errors = JSON.parse(errorsText)
    expect(errors).toMatchInlineSnapshot(`
      {
        "configErrors": [],
        "sessionErrors": [],
      }
    `)
  })

  it('should capture runtime errors with source-mapped stack frames', async () => {
    await next.browser('/runtime-error')

    let errors: any = null
    await retry(async () => {
      const sessionId = 'test-2-' + Date.now()
      const errorsText = await callGetErrors(sessionId)
      errors = JSON.parse(errorsText)
      expect(errors.sessionErrors).toHaveLength(1)
      expect(errors.sessionErrors[0].runtimeErrors).toHaveLength(1)
    })

    expect(errors.sessionErrors[0]).toMatchObject({
      url: '/runtime-error',
      buildError: null,
      runtimeErrors: [
        {
          type: 'runtime',
          errorName: 'Error',
          message: 'Test runtime error',
          isFatal: true,
          stack: expect.arrayContaining([
            expect.objectContaining({
              file: expect.stringContaining('app/runtime-error/page.tsx'),
              methodName: 'RuntimeErrorPage',
            }),
          ]),
        },
      ],
    })
  })

  it('should classify App Router runtime errors by whether the app was replaced', async () => {
    const browser = await next.browser('/client-runtime-error')

    await waitForRuntimeError({
      url: '/client-runtime-error',
      message: 'Test client runtime error',
      isFatal: true,
    })

    await browser.loadPage(`${next.url}/caught-runtime-error`)
    await waitForRuntimeError({
      url: '/caught-runtime-error',
      message: 'Test caught runtime error',
      isFatal: false,
    })
    expect(
      await browser.eval(
        () => document.querySelector('#caught-fallback')?.textContent
      )
    ).toBe('Caught fallback')

    await browser.loadPage(`${next.url}/event-runtime-error`)
    await browser.elementByCss('#event-error').click()
    await waitForRuntimeError({
      url: '/event-runtime-error',
      message: 'Test event runtime error',
      isFatal: false,
    })
    expect(
      await browser.eval(
        () => document.querySelector('#event-page-content')?.textContent
      )
    ).toBe('Page remains rendered')

    await browser.loadPage(`${next.url}/rejection-runtime-error`)
    await browser.elementByCss('#rejection-error').click()
    await waitForRuntimeError({
      url: '/rejection-runtime-error',
      message: 'Test unhandled rejection',
      isFatal: false,
    })

    await browser.loadPage(`${next.url}/console-runtime-error`)
    await browser.elementByCss('#console-error').click()
    await waitForRuntimeError({
      url: '/console-runtime-error',
      message: 'Test console error',
      type: 'console',
      isFatal: false,
    })

    await browser.loadPage(`${next.url}/hydration-runtime-error`)
    await waitForRuntimeError({
      url: '/hydration-runtime-error',
      type: 'recoverable',
      isFatal: false,
    })
  })

  it('should treat a route error boundary as non-fatal', async () => {
    const browser = await next.browser('/route-boundary-error')

    await waitForRuntimeError({
      url: '/route-boundary-error',
      message: 'Test route boundary error',
      isFatal: false,
    })
    expect(
      await browser.eval(
        () => document.querySelector('#route-error-fallback')?.textContent
      )
    ).toBe('Test route boundary error')

    await next.patchFile(
      'app/route-boundary-error/page.tsx',
      `export default function RouteBoundaryErrorPage() {
  return <p id="route-error-fixed">Route fixed</p>
}
`
    )
    await retry(async () => {
      if (
        await browser.eval(() =>
          Boolean(document.querySelector('#route-error-reset'))
        )
      ) {
        await browser.elementByCss('#route-error-reset').click()
      }
      expect(
        await browser.eval(
          () => document.querySelector('#route-error-fixed')?.textContent
        )
      ).toBe('Route fixed')

      const errorsText = await callGetErrors(
        `test-route-boundary-fixed-${Date.now()}`
      )
      const errors = JSON.parse(errorsText)
      expect(
        errors.sessionErrors.find(
          (entry: any) => entry.url === '/route-boundary-error'
        )
      ).toBeUndefined()
    })
  })

  it('should promote a reused error when it later replaces the app', async () => {
    const browser = await next.browser('/shared-runtime-error')
    const getOverlayErrorType = () =>
      browser.eval(() => {
        const portal = Array.from(
          document.querySelectorAll('nextjs-portal')
        ).find((candidate) =>
          candidate.shadowRoot?.querySelector('#nextjs__container_errors_label')
        )
        return (
          portal?.shadowRoot?.querySelector('#nextjs__container_errors_label')
            ?.textContent ?? null
        )
      })

    await browser.elementByCss('#log-shared-error').click()
    await waitForRuntimeError({
      url: '/shared-runtime-error',
      message: 'Test shared runtime error',
      type: 'console',
      isFatal: false,
    })
    await retry(async () => {
      expect(await getOverlayErrorType()).toBe('Console Error')
    })

    await browser.elementByCss('#log-background-error').click()
    await waitForRuntimeError({
      url: '/shared-runtime-error',
      message: 'Test background runtime error',
      type: 'console',
      isFatal: false,
    })

    expect(
      await browser.eval(
        () => document.querySelector('#shared-page-content')?.textContent
      )
    ).toBe('Page remains rendered')

    await browser.elementByCss('#throw-shared-error').click()
    await waitForRuntimeError({
      url: '/shared-runtime-error',
      message: 'Test shared runtime error',
      isFatal: true,
    })
    await waitForRuntimeError({
      url: '/shared-runtime-error',
      message: 'Test background runtime error',
      type: 'console',
      isFatal: false,
    })
    await retry(async () => {
      expect(await getOverlayErrorType()).toBe('Runtime Error')
    })
    expect(
      await browser.eval(
        () => document.querySelector('#global-error-fallback')?.textContent
      )
    ).toBe('Test shared runtime error')
  })

  it('should classify a non-Error root throw as fatal', async () => {
    const browser = await next.browser('/non-error-runtime-error')

    await waitForRuntimeError({
      url: '/non-error-runtime-error',
      message: 'Test non-Error runtime error',
      isFatal: true,
    })
    expect(
      await browser.eval(
        () => document.querySelector('#global-error-fallback')?.textContent
      )
    ).toBe('Test non-Error runtime error')
  })

  it('should classify Pages Router runtime errors by whether the app was replaced', async () => {
    const browser = await next.browser('/pages-runtime-error')

    await waitForRuntimeError({
      url: '/pages-runtime-error',
      message: 'Test Pages runtime error',
      isFatal: true,
    })

    await browser.loadPage(`${next.url}/pages-caught-runtime-error`)
    await waitForRuntimeError({
      url: '/pages-caught-runtime-error',
      message: 'Test Pages caught runtime error',
      isFatal: false,
    })
    expect(
      await browser.eval(
        () => document.querySelector('#pages-caught-fallback')?.textContent
      )
    ).toBe('Caught fallback')

    await browser.loadPage(`${next.url}/pages-event-runtime-error`)
    await browser.elementByCss('#pages-event-error').click()
    await waitForRuntimeError({
      url: '/pages-event-runtime-error',
      message: 'Test Pages event runtime error',
      isFatal: false,
    })
    expect(
      await browser.eval(
        () => document.querySelector('#pages-event-page-content')?.textContent
      )
    ).toBe('Page remains rendered')
  })

  it('should clear fatality with the runtime error after HMR recovery', async () => {
    const browser = await next.browser('/hmr-runtime-error')

    await waitForRuntimeError({
      url: '/hmr-runtime-error',
      message: 'Test HMR runtime error',
      isFatal: true,
    })

    await next.patchFile(
      'app/hmr-runtime-error/page.tsx',
      `'use client'\n\nexport default function HmrRuntimeErrorPage() {\n  return <p id="hmr-fixed">HMR fixed</p>\n}\n`
    )

    await retry(async () => {
      expect(
        await browser.eval(
          () => document.querySelector('#hmr-fixed')?.textContent
        )
      ).toBe('HMR fixed')

      const errorsText = await callGetErrors(`test-hmr-fixed-${Date.now()}`)
      const errors = JSON.parse(errorsText)
      const session = errors.sessionErrors.find(
        (entry: any) => entry.url === '/hmr-runtime-error'
      )
      expect(
        session?.runtimeErrors.find(
          (error: any) => error.message === 'Test HMR runtime error'
        )
      ).toBeUndefined()
    })
  })

  it('should capture build errors when directly visiting error page', async () => {
    await next.browser('/build-error')

    let errors: any = null
    await retry(async () => {
      const sessionId = 'test-4-' + Date.now()
      const errorsText = await callGetErrors(sessionId)
      errors = JSON.parse(errorsText)
      expect(errors.sessionErrors).toHaveLength(1)
      expect(errors.sessionErrors[0].buildError).toBeTruthy()
    })

    expect(errors.sessionErrors[0]).toMatchObject({
      url: '/build-error',
      buildError: expect.any(String),
    })

    // Check the build error contains the expected syntax error message
    expect(stripAnsi(errors.sessionErrors[0].buildError)).toContain(
      'Unexpected token. Did you mean'
    )
    expect(stripAnsi(errors.sessionErrors[0].buildError)).toContain(
      'build-error/page.tsx'
    )
  })

  it('should capture errors from multiple browser sessions', async () => {
    // Restart the server
    await next.stop()
    await next.start()

    // Open two independent browser sessions concurrently
    const [s1, s2] = await Promise.all([
      launchStandaloneSession(next.url, '/runtime-error'),
      launchStandaloneSession(next.url, '/runtime-error-2'),
    ])

    try {
      let errors: any = null
      await retry(async () => {
        const sessionId = 'test-multi-' + Date.now()
        const errorsText = await callGetErrors(sessionId)
        errors = JSON.parse(errorsText)
        // Check that we have at least the 2 sessions we created
        expect(errors.sessionErrors.length).toBeGreaterThanOrEqual(2)
        // Ensure both our sessions are present
        const urls = errors.sessionErrors.map((s: any) => s.url)
        expect(urls).toContain('/runtime-error')
        expect(urls).toContain('/runtime-error-2')
      })

      // Find each session's errors
      const session1 = errors.sessionErrors.find(
        (s: any) => s.url === '/runtime-error'
      )
      const session2 = errors.sessionErrors.find(
        (s: any) => s.url === '/runtime-error-2'
      )

      expect(session1).toMatchObject({
        url: '/runtime-error',
        runtimeErrors: [
          {
            type: 'runtime',
            message: 'Test runtime error',
            isFatal: true,
            stack: expect.arrayContaining([
              expect.objectContaining({
                file: expect.stringContaining('app/runtime-error/page.tsx'),
                methodName: 'RuntimeErrorPage',
              }),
            ]),
          },
        ],
      })

      expect(session2).toMatchObject({
        url: '/runtime-error-2',
        runtimeErrors: [
          {
            type: 'runtime',
            message: 'Test runtime error 2',
            isFatal: true,
            stack: expect.arrayContaining([
              expect.objectContaining({
                file: expect.stringContaining('app/runtime-error-2/page.tsx'),
                methodName: 'RuntimeErrorPage',
              }),
            ]),
          },
        ],
      })
    } finally {
      await s1.close()
      await s2.close()
    }
  })

  it('should capture next.config errors and clear when fixed', async () => {
    // Read the original config
    const originalConfig = await next.readFile('next.config.js')

    // Stop server, write invalid config, and restart
    await next.stop()
    await next.patchFile(
      'next.config.js',
      `module.exports = {
  experimental: {
    invalidTestProperty: 'this should cause a validation warning',
  },
}`
    )
    await next.start()

    // Open a browser session
    await next.browser('/')

    // Check that the config error is captured
    let errors: any = null
    await retry(async () => {
      const sessionId = 'test-config-error-' + Date.now()
      const errorsText = await callGetErrors(sessionId)
      errors = JSON.parse(errorsText)
      expect(errors.configErrors.length).toBeGreaterThan(0)
    })

    expect(errors.configErrors[0]).toMatchObject({
      message: expect.stringContaining(
        'Invalid next.config.js options detected'
      ),
    })
    expect(errors.configErrors[0].message).toContain('invalidTestProperty')

    // Stop server, fix the config, and restart
    await next.stop()
    await next.patchFile('next.config.js', originalConfig)
    await next.start()

    // Open a browser session
    await next.browser('/')

    // Verify the config error is now gone
    await retry(async () => {
      const sessionId = 'test-config-fixed-' + Date.now()
      const fixedErrorsText = await callGetErrors(sessionId)
      const fixedErrors = JSON.parse(fixedErrorsText)
      expect(fixedErrors.configErrors).toHaveLength(0)
      expect(fixedErrors.sessionErrors).toHaveLength(0)
    })
  })
})

/**
 * Minimal standalone browser session launcher for testing multiple concurrent browser tabs.
 * The standard test harness (next.browser) uses a singleton browser instance which doesn't
 * support concurrent tabs needed for testing errors across multiple browser sessions.
 */
async function launchStandaloneSession(
  appPortOrUrl: string | number,
  url: string
) {
  const headless = !!process.env.HEADLESS
  const browserName = (process.env.BROWSER_NAME || 'chrome').toLowerCase()

  let browser: Browser
  if (browserName === 'safari') {
    browser = await webkit.launch({ headless })
  } else if (browserName === 'firefox') {
    browser = await firefox.launch({ headless })
  } else {
    browser = await chromium.launch({ headless })
  }

  const context = await browser.newContext()
  const page = await context.newPage()

  const fullUrl = getFullUrl(appPortOrUrl, url)
  debugPrint(`Loading standalone browser with ${fullUrl}`)

  page.on('pageerror', (error) => debugPrint('Standalone page error', error))

  await page.goto(fullUrl, { waitUntil: 'load' })
  debugPrint(`Loaded standalone browser with ${fullUrl}`)

  return {
    page,
    close: async () => {
      await page.close().catch(() => {})
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}
