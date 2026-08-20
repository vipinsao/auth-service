# Development image. It runs the TypeScript sources through nodemon so the
# bind-mounted working tree reloads on save; it is not a production image.
FROM node:24-bookworm-slim

WORKDIR /usr/src/app

# Copy the manifests first so `npm ci` is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5501

# Generate the RS256 key pair on first boot only, so restarting the container
# does not invalidate access tokens that are still in flight.
CMD ["sh", "-c", "[ -f certs/private.pem ] || npm run keys:generate; npm run dev"]
