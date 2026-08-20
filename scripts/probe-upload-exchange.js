// @ts-check
// Throwaway integration probe for the OIDC upload-token exchange in
// vercel-packages. Exchanges this workflow's GitHub OIDC token for an upload
// access token at a preview deployment (any branch is authorized there) and
// uploads a random text file, then records how production answers the same
// exchange (no POST endpoint deployed yet; once deployed, this branch's token
// must be rejected because only canary runs may upload).
const { put } = require('@vercel/blob/client')
const crypto = require('node:crypto')

const PREVIEW_BUILDS_AUDIENCE = 'https://vercel-packages.vercel.app'
// Deliberately not a real commit so the probe can never collide with (or
// overwrite) an actual preview build.
const PROBE_COMMIT_SHA = '0000000000000000000000000000000000000000'
const PROBE_PACKAGE_NAME = 'probe'

/**
 * @param {string} audience
 * @returns {Promise<string>}
 */
async function mintGitHubActionsOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!requestUrl || !requestToken) {
    throw new Error(
      'ACTIONS_ID_TOKEN_REQUEST_URL is not set. ' +
        'The job needs the `id-token: write` permission.'
    )
  }

  const url = new URL(requestUrl)
  url.searchParams.set('audience', audience)
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${requestToken}` },
  })
  if (!response.ok) {
    throw new Error(
      `Failed to mint GitHub OIDC token: ${response.status} ${await response.text()}`
    )
  }

  const { value } = await response.json()
  return value
}

/**
 * @param {string} baseUrl
 * @param {string} oidcToken
 * @returns {Promise<{ status: number, body: string }>}
 */
async function exchangeOidcForUploadToken(baseUrl, oidcToken) {
  const response = await fetch(
    `${baseUrl}/commits/${PROBE_COMMIT_SHA}/${PROBE_PACKAGE_NAME}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${oidcToken}` },
    }
  )
  return { status: response.status, body: await response.text() }
}

async function main() {
  const previewBaseUrl = process.env.PREVIEW_DEPLOYMENT_BASE_URL
  const productionBaseUrl = process.env.PRODUCTION_BASE_URL
  if (!previewBaseUrl || !productionBaseUrl) {
    throw new Error(
      'PREVIEW_DEPLOYMENT_BASE_URL and PRODUCTION_BASE_URL must be set'
    )
  }

  const oidcToken = await mintGitHubActionsOidcToken(PREVIEW_BUILDS_AUDIENCE)
  const claims = JSON.parse(
    Buffer.from(oidcToken.split('.')[1], 'base64url').toString()
  )
  console.info(`Minted OIDC token with job_workflow_ref=${claims.job_workflow_ref}`)

  const preview = await exchangeOidcForUploadToken(previewBaseUrl, oidcToken)
  if (preview.status !== 200) {
    throw new Error(
      `Preview exchange must succeed for any branch but got ${preview.status}: ${preview.body}`
    )
  }
  console.info('Preview exchange: 200 (client token received)')
  const { clientToken } = JSON.parse(preview.body)

  const content = `upload probe ${crypto.randomBytes(32).toString('hex')}\n`
  const { url } = await put(
    `next/commits/${PROBE_COMMIT_SHA}/${PROBE_PACKAGE_NAME}.tgz`,
    content,
    {
      access: 'public',
      token: clientToken,
      contentType: 'text/plain',
    }
  )
  console.info(`Preview upload succeeded -> ${url}`)

  const production = await exchangeOidcForUploadToken(
    productionBaseUrl,
    oidcToken
  )
  console.info(
    `Production exchange: ${production.status} ${production.body} ` +
      '(expected to fail: the POST endpoint is not deployed yet, and once it ' +
      'is, this branch is not canary)'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
