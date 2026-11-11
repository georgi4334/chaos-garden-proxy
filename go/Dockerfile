# Chaos Garden fault proxy, Go implementation. Build from this folder:
#   docker build -t chaos-garden-proxy-go .
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
# Static binary (no C library needed), without debug info.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/proxy ./cmd/proxy

# Distroless: no shell, no package manager, just the binary and CA certificates.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/proxy /proxy
ENV PORT=3100 \
    LOG_FORMAT=json
EXPOSE 3100
USER nonroot
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["/proxy", "healthcheck"]
ENTRYPOINT ["/proxy"]
