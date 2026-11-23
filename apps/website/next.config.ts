import path from "node:path";
import type { NextConfig } from "next";

// npm workspaces: dependencies are hoisted to the repository root.
const root = path.join(__dirname, "../..");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server for the production image (infra/docker/website.Dockerfile).
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default config;
