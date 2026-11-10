# One image for the fleet's worker, API and mock bank (docs/plans/step-06.md section 5, D28).
#
# Pinned to the repo's Playwright version: the browsers baked into the base image match the npm
# package only when the versions are equal. The worker re-checks this at startup against
# PLAYWRIGHT_VERSION and refuses to run on a mismatch.
#
#   docker compose build            # or: docker build -t rote .
ARG PLAYWRIGHT_VERSION=1.62.1

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY mock-app ./mock-app
COPY scripts ./scripts
COPY examples ./examples
RUN npm run build

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
COPY package.json package-lock.json ./
# Runtime gets production dependencies only (tsx, vitest, typescript stay in the build stage).
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Resolved relative to the working directory by the code (artifacts/, overrides/, status/, db/migrations/).
COPY artifacts ./artifacts
COPY overrides ./overrides
COPY status ./status
COPY db ./db
# Worker evidence volume; created here so a fresh named volume inherits pwuser's ownership.
RUN mkdir -p /evidence && chown pwuser:pwuser /evidence
USER pwuser
CMD ["node", "dist/src/worker/main.js"]
