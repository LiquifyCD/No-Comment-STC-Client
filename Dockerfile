# One static Go binary with the web app embedded.
FROM golang:1.26.11-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/stc-client ./cmd/stc-client

FROM debian:bookworm-slim
# The app calls the BRP API over HTTPS; the slim image ships no CA bundle.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/stc-client /usr/local/bin/stc-client
# Unprivileged: the data dir must be owned by 10001:10001 and the secrets dir
# readable by group 10001.
USER 10001:10001
EXPOSE 8796
ENTRYPOINT ["/usr/local/bin/stc-client"]
