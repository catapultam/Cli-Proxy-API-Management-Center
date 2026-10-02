# Builds the single-file UI and serves it with nginx. Every path that is not the
# UI itself is reverse-proxied to the CLIProxyAPI backend, so the UI and the
# Management API share one origin and the login page detects the API address.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG VERSION=dev
ENV VERSION=${VERSION}
RUN bun run build

FROM nginx:alpine
# Backend the proxy forwards to (scheme://host:port, no trailing slash).
ENV CPA_BACKEND=http://cli-proxy-api:8317
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/index.html /usr/share/nginx/html/index.html
COPY --from=build /app/dist/index.html /usr/share/nginx/html/management.html
EXPOSE 80
