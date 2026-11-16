import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    // Pin it since the suite is about the Turbopack chunk-group bootstrap that
    // the shared runtime receives from its `<script>` tag attribute.
    turbopackSharedRuntime: true,
  },
}

export default nextConfig
