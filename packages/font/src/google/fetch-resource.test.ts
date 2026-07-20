import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchResource } from './fetch-resource'

describe('next/font/google fetchResource', () => {
  // A server that accepts the connection but never responds, simulating a
  // hanging network (offline with dropped packets, a captive portal, etc.).
  let server: http.Server
  let url: string

  beforeAll(async () => {
    server = http.createServer(() => {})
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = server.address() as AddressInfo
    url = `http://127.0.0.1:${port}/`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('times out in dev instead of hanging', async () => {
    await expect(fetchResource(url, true)).rejects.toThrow(
      'Request timed out after 3000ms'
    )
  }, 10000)

  it('times out during build instead of hanging forever', async () => {
    await expect(fetchResource(url, false)).rejects.toThrow(
      'Request timed out after 6000ms'
    )
  }, 15000)
})
