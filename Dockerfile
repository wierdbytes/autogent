# autogent-nostr container image (remote plan §6.3).
#
# The harness must be the signal target of the container: k8s sends SIGTERM to
# PID 1 and gives us terminationGracePeriodSeconds (60s) to drain, publish the
# presence farewell and close the relay. tini is PID 1 purely for signal
# forwarding and zombie reaping of model-spawned tools; it execs nothing else.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# git: the NIP-34 git tooling (§5.3) drives the stock git CLI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin agent

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER agent

# /data is the PVC: sealed state (identity, SQLite, pi auth.json) and the
# workspace the model's tools operate in. The bootstrap triple (AUTOGENT_NSEC,
# AUTOGENT_RELAY_URL, AUTOGENT_AUTH_TAG) arrives via the k8s Secret; the rest
# of the configuration arrives as the core engram over the relay (§3.3).
ENV NODE_ENV=production \
    AUTOGENT_STATE_DIR=/data/state \
    AUTOGENT_CWD=/data/workspace \
    AUTOGENT_ENGRAM_CONFIG=1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["run"]
