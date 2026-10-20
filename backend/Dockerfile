FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM alpine:3.22
# CA certificates for the HTTPS requests the network proxy makes.
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 app
COPY --from=build /out/server /usr/local/bin/server
USER app
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/server"]
