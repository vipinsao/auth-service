# Development image. It runs the TypeScript sources through nodemon so the
# bind-mounted working tree reloads on save; it is not a production image.
FROM node:24-bookworm-slim

WORKDIR /usr/src/app

# Copy the manifests first so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5501

# Start-up order: key pair, then schema, then the service.
#
# The key pair is generated on first boot only, so restarting the container does
# not invalidate access tokens that are still in flight.
#
# `synchronize` is off outside NODE_ENV=test, so the schema has to exist before
# the service opens its connection pool. `migration:run` is idempotent - a
# second run on an already-migrated database applies nothing - so it belongs on
# every boot, not just the first, and `&&` means a failed migration stops the
# container instead of starting a service against a half-built schema.
CMD ["sh", "-c", "[ -f certs/private.pem ] || npm run keys:generate; npm run migration:run && npm run dev"]
