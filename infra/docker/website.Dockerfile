# Production image for the landing page (apps/website), built from the repository root:
#   docker build -f infra/docker/website.Dockerfile -t disc-voice-website .
FROM node:24-bookworm-slim AS build
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# npm ci checks every workspace listed in the lockfile, so all manifests are copied;
# only the website's dependencies are installed.
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/website/package.json apps/website/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @disc-voice/website --include-workspace-root=false
COPY apps/website apps/website
# Download links are inlined into the page at build time.
ARG NEXT_PUBLIC_DOWNLOAD_WINDOWS="" NEXT_PUBLIC_DOWNLOAD_MAC="" NEXT_PUBLIC_DOWNLOAD_LINUX=""
RUN npm run build --workspace @disc-voice/website

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# The standalone output holds server.js and only the node_modules it traced.
COPY --from=build --chown=node:node /build/apps/website/.next/standalone ./
COPY --from=build --chown=node:node /build/apps/website/.next/static ./apps/website/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/website/server.js"]
