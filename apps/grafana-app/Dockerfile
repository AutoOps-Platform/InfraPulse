# Optional Linux-only artifact build. Does not start Grafana or publish an image.
# BuildKit export: docker build --target artifacts --output type=local,dest=dist .
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS frontend
WORKDIR /build
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY .config ./.config
COPY tsconfig.json webpack.config.ts eslint.config.mjs .prettierrc.js README.md LICENSE CHANGELOG.md ./
COPY src ./src
RUN pnpm build

FROM golang:1.27.1-bookworm AS backend
WORKDIR /build
ENV GOTOOLCHAIN=local CGO_ENABLED=0
COPY go.mod go.sum ./
RUN go mod download
COPY pkg ./pkg
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 -o "$TARGETARCH" = arm64 && \
    GOOS=linux GOARCH="$TARGETARCH" go build -trimpath -ldflags='-s -w' \
    -o "/out/gpx_infrapulse_linux_$TARGETARCH" ./pkg

FROM scratch AS artifacts
COPY --from=frontend /build/dist/ /
COPY --from=backend --chmod=0755 /out/ /
