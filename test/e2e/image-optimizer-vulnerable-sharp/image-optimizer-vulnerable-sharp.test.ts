import { nextTestSetup } from 'e2e-utils'
import fs from 'fs-extra'
import { join } from 'path'

describe('image-optimizer-vulnerable-sharp', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipDeployment: true,
    packageJson: {
      pnpm: {
        overrides: {
          // sharp 0.34.5 bundles libheif 1.20.2, which is affected by the
          // AVIF decoding vulnerabilities fixed in libheif 1.23.2.
          sharp: '0.34.5',
        },
      },
    },
  })

  it('serves AVIF input unoptimized when sharp bundles a vulnerable libheif', async () => {
    const query = new URLSearchParams({ url: '/test.avif', w: '256', q: '75' })
    const res = await next.fetch(`/_next/image?${query}`, {
      headers: { accept: 'image/webp' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/avif')
    const source = await fs.readFile(join(__dirname, 'public/test.avif'))
    expect(Buffer.from(await res.arrayBuffer()).equals(source)).toBe(true)
  })

  it('still optimizes other formats', async () => {
    const query = new URLSearchParams({ url: '/test.png', w: '256', q: '75' })
    const res = await next.fetch(`/_next/image?${query}`, {
      headers: { accept: 'image/webp' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
  })
})
