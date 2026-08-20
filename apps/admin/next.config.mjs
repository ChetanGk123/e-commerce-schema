/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // @ecom/schema ships TypeScript source rather than a build -- its exports
  // map points straight at .ts files -- so Next has to compile it like any
  // other module in this app. Without this the first import of it fails at
  // build with a syntax error inside node_modules, which reads like a
  // broken dependency rather than a missing line here.
  transpilePackages: ["@ecom/schema"],
  reactCompiler: true,
  // Nothing gains from advertising the framework.
  poweredByHeader: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  // A full CSP is deliberately absent: Next needs per-request nonces for its inline
  // scripts, which is a proxy-layer job rather than a static config. HSTS likewise
  // belongs on whatever terminates TLS. These four cost nothing and break nothing.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // An admin dashboard is never legitimately framed. X-Frame-Options for old
          // agents, frame-ancestors for the ones that follow the spec.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
