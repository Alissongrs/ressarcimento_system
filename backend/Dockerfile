FROM golang:1.23-alpine AS build

WORKDIR /app

RUN apk add --no-cache tzdata ca-certificates && update-ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o server .

FROM alpine:3.19

WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata && update-ca-certificates

COPY --from=build /app/server /app/server

EXPOSE 8080
CMD ["/app/server"]