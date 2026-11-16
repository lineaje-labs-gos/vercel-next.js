import { nextTestSetup, type Playwright } from 'e2e-utils'
import { retry } from 'next-test-utils'
import { splitResponseWithPPRSentinel } from 'e2e-utils/ppr'
import cheerio from 'cheerio'

// With `experimental.turbopackSharedRuntime`, the Turbopack chunk-group
// bootstrap is carried by the shared runtime's `<script>` tag, as JSON in this
// attribute. It used to be an inline script,
// `(globalThis["TURBOPACK"] || ...).push({"otherChunks":...})`, which needs a
// CSP nonce and therefore couldn't be part of a static shell.
const BOOTSTRAP_ATTRIBUTE = 'data-turbopack-bootstrap'
const INLINE_BOOTSTRAP_MARKER = '"otherChunks"'

type BootstrapParams = {
  otherChunks: Array<string | { path: string }>
  runtimeModuleIds: unknown[]
}

function getNonce(csp: string | null): string {
  const match = csp?.match(/'nonce-([^']+)'/)
  if (!match) throw new Error(`Expected a nonce in the CSP header: ${csp}`)
  return match[1]
}

function getInlineBootstrapScripts(html: string) {
  const $ = cheerio.load(html)
  return $('script:not([src])')
    .toArray()
    .filter((element) => $(element).html()!.includes(INLINE_BOOTSTRAP_MARKER))
}

function getBootstrapAttributeScripts(html: string) {
  const $ = cheerio.load(html)
  return $(`script[${BOOTSTRAP_ATTRIBUTE}]`)
    .toArray()
    .map((element) => ({
      src: $(element).attr('src')!,
      params: JSON.parse(
        $(element).attr(BOOTSTRAP_ATTRIBUTE)!
      ) as BootstrapParams[],
    }))
}

function getChunkScriptPaths(params: BootstrapParams[]) {
  return params
    .flatMap((p) => p.otherChunks)
    .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.path))
    .filter((path) => path.endsWith('.js'))
}

async function expectNoUnexpectedCspViolations(browser: Playwright) {
  if (global.browserName !== 'chrome') return

  const logs = await browser.log()
  const cspViolations = logs.filter(
    (log) =>
      log.message.includes('Content Security Policy') &&
      // React's `$RT` timing script in the static shell has no nonce
      // either. It doesn't affect hydration, so only the inline scripts
      // that matter are checked below.
      !log.message.includes('Executing inline script')
  )
  expect(cspViolations).toEqual([])
  const inlineViolations = logs.filter((log) =>
    log.message.includes('Executing inline script')
  )
  // At most the `$RT` script may be blocked.
  expect(inlineViolations.length).toBeLessThanOrEqual(1)
}

// The shared runtime (and thus the chunk-group bootstrap) only exists in
// Turbopack production builds.
// @force-gate !dev && turbopack
describe('ppr-shared-runtime-csp-nonce', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('should carry the bootstrap on the shared runtime script in the static shell', async () => {
    const [staticPart, dynamicPart] = await splitResponseWithPPRSentinel(
      async () => (await next.fetch('/')).body
    )
    expect(dynamicPart).not.toBe('')

    const scripts = getBootstrapAttributeScripts(staticPart)
    expect(scripts).toHaveLength(1)
    const [{ src, params }] = scripts
    expect(params).toEqual([
      expect.objectContaining({
        otherChunks: expect.any(Array),
        runtimeModuleIds: expect.any(Array),
      }),
    ])
    expect(getChunkScriptPaths(params).length).toBeGreaterThan(0)

    // The attribute is on the shared runtime chunk, the script that reads it.
    const runtime = await (await next.fetch(src)).text()
    expect(runtime).toContain(BOOTSTRAP_ATTRIBUTE)

    expect(getBootstrapAttributeScripts(dynamicPart)).toEqual([])
  })

  it.each(['nonce', 'report-only', 'none'])(
    'should not emit an inline bootstrap script (csp: %s)',
    async (mode) => {
      const [staticPart, dynamicPart] = await splitResponseWithPPRSentinel(
        async () => {
          const res = await next.fetch(`/?csp=${mode}`)
          if (mode === 'nonce') {
            const nonce = getNonce(res.headers.get('content-security-policy'))
            // The fixture allows the Vercel toolbar that preview deployments
            // inject.
            expect(res.headers.get('content-security-policy')).toContain(
              `script-src 'self' 'nonce-${nonce}' https://vercel.live;`
            )
          }
          return res.body
        }
      )

      expect(getInlineBootstrapScripts(staticPart)).toEqual([])
      expect(getInlineBootstrapScripts(dynamicPart)).toEqual([])
      expect(getBootstrapAttributeScripts(staticPart)).toHaveLength(1)
    }
  )

  it('should hydrate under a nonce-based CSP without CSP violations for the bootstrap', async () => {
    const browser = await next.browser('/')

    await browser.waitForElementByCss('#counter[data-hydrated="true"]')
    await browser.elementByCss('#counter').click()
    await retry(async () => {
      expect(await browser.elementByCss('#counter').text()).toBe('1')
    })
    expect(await browser.elementByCss('#dynamic').text()).toBe('dynamic')

    await expectNoUnexpectedCspViolations(browser)
  })

  // The runtime reads the bootstrap from its own script tag when it executes,
  // so make sure that works both when the entry's chunks have already run and
  // registered themselves, and when they run after the runtime.
  it.each([
    ['before', 'the entry chunks run before the shared runtime'],
    ['after', 'the entry chunks run after the shared runtime'],
  ])('should hydrate when %s: %s', async (order) => {
    const browser = await next.browser('/', {
      pushErrorAsConsoleLog: true,
      async beforePageLoad(page) {
        await page.route(
          (url) => url.pathname === '/',
          async (route) => {
            const response = await route.fetch()
            let html = await response.text()

            const [{ src, params }] = getBootstrapAttributeScripts(html)
            const chunkScripts = getChunkScriptPaths(params)
              .map((path) => `<script src="/_next/${path}"></script>`)
              .join('')

            // Make every script blocking, so their order is deterministic.
            html = html.replace(/(<script src="[^"]+"[^>]*?) async=""/g, '$1')
            if (order === 'before') {
              // Blocking chunk scripts at the very start of the head run
              // before the runtime script.
              html = html.replace(/<head[^>]*>/, (head) => head + chunkScripts)
            } else {
              // Move the runtime to the very start of the head, so it runs
              // before any of the entry's chunks. The attribute value is
              // HTML-escaped, so it can't contain a raw `"`.
              const runtimeTag = html.match(
                new RegExp(
                  `<script[^>]*${BOOTSTRAP_ATTRIBUTE}="[^"]*"[^>]*></script>`
                )
              )![0]
              expect(runtimeTag).toContain(src)
              html = html
                .replace(runtimeTag, '')
                .replace('</head>', `${chunkScripts}</head>`)
                .replace(/<head[^>]*>/, (head) => head + runtimeTag)
            }
            await route.fulfill({ response, body: html })
          }
        )
      },
    })

    await browser.waitForElementByCss('#counter[data-hydrated="true"]')
    await browser.elementByCss('#counter').click()
    await retry(async () => {
      expect(await browser.elementByCss('#counter').text()).toBe('1')
    })

    const pageErrors = (await browser.log()).filter(
      (log) =>
        log.source === 'error' &&
        // React's `$RT` timing script in the static shell has no nonce.
        !log.message.includes('Content Security Policy')
    )
    expect(pageErrors).toEqual([])
  })

  it('should carry the bootstrap on the shared runtime script in fully static pages', async () => {
    const html = await next.render('/static')
    expect(getInlineBootstrapScripts(html)).toEqual([])
    expect(getBootstrapAttributeScripts(html)).toHaveLength(1)

    const browser = await next.browser('/static')
    await browser.waitForElementByCss('#counter[data-hydrated="true"]')
    await browser.elementByCss('#counter').click()
    await retry(async () => {
      expect(await browser.elementByCss('#counter').text()).toBe('1')
    })
  })
})
