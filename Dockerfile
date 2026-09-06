# ─── Build stage ──────────────────────────────────────────────────────────
# Debian (glibc), NOT Alpine (musl). glibc images "just work" with native
# modules like lightningcss and Prisma — no special binary targets needed.
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Prisma's query engine needs OpenSSL present.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install dependencies INSIDE this image so every native binary (lightningcss,
# prisma) matches the container's platform. Never copy node_modules from the host.
#
# DO NOT copy the macOS package-lock.json: it pins the macOS native packages and
# makes npm skip the Linux binaries (lightningcss/rollup/esbuild) — the npm
# optionalDependencies bug (npm/cli#4828). Installing from package.json alone
# forces a fresh, Linux-correct resolve that pulls the right native binaries.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Now bring in the source (host node_modules/.env excluded via .dockerignore)
COPY . .

# Client-side (VITE_*) variables must be present at BUILD time — Vite inlines
# them into the browser bundle. These are PUBLIC values (Pusher app key/cluster,
# group links), not secrets, so it's safe to embed them. Without them the client
# ships with no Pusher key and realtime (live rounds) is silently disabled.
ARG VITE_PUSHER_KEY
ARG VITE_PUSHER_CLUSTER
ARG VITE_MESSENGER_GROUP_URL
ARG VITE_WHATSAPP_GROUP_URL
ENV VITE_PUSHER_KEY=$VITE_PUSHER_KEY \
    VITE_PUSHER_CLUSTER=$VITE_PUSHER_CLUSTER \
    VITE_MESSENGER_GROUP_URL=$VITE_MESSENGER_GROUP_URL \
    VITE_WHATSAPP_GROUP_URL=$VITE_WHATSAPP_GROUP_URL

RUN npx prisma generate
RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy only what's needed to run the server.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts

EXPOSE 5176
# DATABASE_URL and other secrets are injected at runtime (docker run -e ...),
# NOT baked into the image.
CMD ["npm", "run", "start"]
