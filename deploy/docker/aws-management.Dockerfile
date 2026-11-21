ARG NODE_BASE=docker.io/library/node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
FROM ${NODE_BASE} AS build
WORKDIR /source
RUN npm install --global --ignore-scripts pnpm@11.24.0

COPY deploy/ ./deploy/
COPY agents/ssm/ ./agents/ssm/
COPY services/management-backend/ ./services/management-backend/
RUN node deploy/scripts/build-ssm-documents.mjs --bootstrap-only

WORKDIR /source/services/management-backend
ENV CI=true
RUN pnpm install --frozen-lockfile \
    && pnpm db:generate \
    && pnpm build \
    && pnpm prune --prod
RUN mkdir -p release \
    && cp /source/deploy/scripts/agent-release.mjs release/ \
    && if [ -f /source/deploy/agent-release.json ]; then cp /source/deploy/agent-release.json release/; fi

FROM ${NODE_BASE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --gid 10002 management && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin management
COPY --from=build /source/services/management-backend/ ./
# The bootstrap bundle is generated as root with mode 0600. Keep root
# ownership and allow only the Management group to read the immutable bundle.
RUN chmod -R a-w release generated \
    && chgrp 10002 generated/bootstrap-assets.json \
    && chmod 0440 generated/bootstrap-assets.json
USER 10002:10002
CMD ["node", "dist/main.js"]
