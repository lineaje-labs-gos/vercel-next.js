import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import type * as Playwright from 'playwright'
import { createRouterAct } from 'router-act'

describe('HTTP access fallback refresh', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('resets a not-found boundary when the same route is refreshed', async () => {
    let page: Playwright.Page
    const browser = await next.browser('/', {
      beforePageLoad(p: Playwright.Page) {
        page = p
      },
    })
    const act = createRouterAct(page)
    await browser.waitForElementByCss('#home')

    await browser.elementById('layout-state').type('preserved')
    await browser.eval(`window.__httpAccessFallbackDocument = 'preserved'`)

    await act(async () => {
      await browser
        .elementByCss('input[data-link-accordion="/protected"]')
        .click()
      await browser.elementByCss('a[href="/protected"]').click()
    })
    await retry(async () => {
      expect(await browser.hasElementByCss('#access-not-found')).toBe(true)
    })
    const protectedUrl = await browser.url()

    async function expectDocumentStateToBePreserved() {
      expect(await browser.url()).toBe(protectedUrl)
      expect(await browser.elementById('layout-state').getValue()).toBe(
        'preserved'
      )
      expect(await browser.eval(`window.__httpAccessFallbackDocument`)).toBe(
        'preserved'
      )
    }

    await expectDocumentStateToBePreserved()

    await act(
      async () => {
        await browser.elementById('grant-access').click()
      },
      { includes: 'Protected content' }
    )
    await retry(async () => {
      expect(await browser.hasElementByCss('#protected-content')).toBe(true)
    })
    await expectDocumentStateToBePreserved()

    await act(async () => {
      await browser.elementById('revoke-access').click()
    })
    await retry(async () => {
      expect(await browser.hasElementByCss('#access-not-found')).toBe(true)
    })
    await expectDocumentStateToBePreserved()

    await act(
      async () => {
        await browser.elementById('grant-access').click()
      },
      { includes: 'Protected content' }
    )
    await retry(async () => {
      expect(await browser.hasElementByCss('#protected-content')).toBe(true)
    })
    await expectDocumentStateToBePreserved()
  })
})
