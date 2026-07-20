import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchResource } from './fetch-resource'

describe('next/font/google fetchResource', () => {
  // A server that accepts the connection but never responds, simulating a
  // hanging network (offline with dropped packets, a captive portal, etc.).
  let server: http.Server
  let url: string
  const proxyEnvVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
  const savedProxyEnv: Record<string, string | undefined> = {}

  beforeAll(async () => {
    // `fetchResource` always routes through a proxy agent when these are set and
    // ignores `NO_PROXY`, so clear them to keep the local hanging server in play.
    for (const key of proxyEnvVars) {
      savedProxyEnv[key] = process.env[key]
      delete process.env[key]
    }
    server = http.createServer(() => {})
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = server.address() as AddressInfo
    url = `http://127.0.0.1:${port}/`
  })

  afterAll(async () => {
    for (const key of proxyEnvVars) {
      if (savedProxyEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedProxyEnv[key]
      }
    }
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
