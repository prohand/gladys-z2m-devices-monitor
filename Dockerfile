# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data (here: the last-seen history)
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

# Pinned by digest (multi-arch index: amd64 + arm64), so a rebuild of the same
# release is the same image. Dependabot (docker ecosystem) bumps it.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown, which
# is when the last-seen history is flushed to /data.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache). `npm ci` only: the
# lockfile is committed and kept in sync, and a fallback to `npm install` would
# silently ship versions nobody tested when it drifts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime: the silence history lives here,
# which is what lets the monitor survive a restart without handing every device
# a fresh threshold.
# Created and handed to `node` BEFORE `VOLUME`: a fresh named volume copies the
# ownership of the image directory, and a root-owned /data would leave the
# unprivileged process unable to write its history.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
