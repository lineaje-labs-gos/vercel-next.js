/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  cacheComponents: true,
  experimental: {
    durableUseCacheEntries: {
      unstableEnvVars: ['MY_DEPLOYMENT_ID'],
      ignoredEnvVars: ['MY_OIDC_TOKEN'],
    },
  },
}

module.exports = nextConfig
