FROM docker.io/library/node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS frontend
WORKDIR /build
ENV CI=true
COPY apps/grafana-app/package.json apps/grafana-app/pnpm-lock.yaml apps/grafana-app/pnpm-workspace.yaml ./
RUN npm install --global --ignore-scripts pnpm@11.24.0 && pnpm install --frozen-lockfile
COPY apps/grafana-app/.config/ ./.config/
COPY apps/grafana-app/tsconfig.json apps/grafana-app/webpack.config.ts apps/grafana-app/README.md apps/grafana-app/LICENSE apps/grafana-app/CHANGELOG.md ./
COPY apps/grafana-app/src/ ./src/
RUN pnpm build

FROM docker.io/library/golang:1.27.1-bookworm@sha256:e114385c58e7280d2f56d6cf374219dda33fef8eb77f72e9f290ccae6160bd90 AS backend
WORKDIR /build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64
COPY apps/grafana-app/go.mod apps/grafana-app/go.sum ./
RUN go mod download && go mod verify
COPY apps/grafana-app/pkg/ ./pkg/
RUN go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/gpx_infrapulse_linux_amd64 ./pkg

FROM docker.io/grafana/grafana:13.3.0@sha256:6e5d306338670f381a942f1c50d3c266bf71531e5ddd9ee4fc1a133dac5ce63d
USER 0:0
RUN mkdir -p /opt/infrapulse/dashboards
COPY --from=frontend --chown=472:472 /build/dist/ /opt/infrapulse/plugins/infrapulse-infrapulse-app/
COPY --from=backend --chown=472:472 --chmod=0755 /out/gpx_infrapulse_linux_amd64 /opt/infrapulse/plugins/infrapulse-infrapulse-app/gpx_infrapulse_linux_amd64
COPY apps/grafana-app/provisioning/app.yaml /etc/infrapulse-aws-provisioning/plugins/app.yaml
COPY apps/grafana-app/provisioning/inventory.yml /etc/infrapulse-aws-provisioning/datasources/inventory.yml
COPY observability/grafana/provisioning/datasources/cloudwatch.yml /etc/infrapulse-aws-provisioning/datasources/cloudwatch.yml
COPY observability/grafana/provisioning/dashboards/providers.yml /etc/infrapulse-aws-provisioning/dashboards/providers.yml
USER 472:472
