# apps/web/Dockerfile — Astro static build. `--target export -o ./dist` pulls
# the built site out to the host for Caddy to serve (hetzner-docker-setup §6);
# there is no running Node for the frontend.
FROM oven/bun:1 AS build
WORKDIR /app
COPY apps/web/package.json ./
RUN bun install
COPY apps/web/ ./
RUN bun run build                       # → /app/dist

FROM scratch AS export
COPY --from=build /app/dist /dist
