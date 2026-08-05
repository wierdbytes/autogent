# autogent-nostr container image (remote plan §6.3).
#
# The harness must be the signal target of the container: k8s sends SIGTERM to
# PID 1 and gives us terminationGracePeriodSeconds (60s) to drain, publish the
# presence farewell and close the relay. tini is PID 1 purely for signal
# forwarding and zombie reaping of model-spawned tools; it execs nothing else.

# --- stage 1: buzz-cli -------------------------------------------------------
# The real `buzz` binary (buzz-cli plan §2), pinned by SHA so the CLI surface
# only moves when BUZZ_REV is bumped deliberately. Built from the public
# workspace; buzz itself needs no changes. rust:1-slim-bookworm shares Debian
# bookworm with node:22-slim, so the dynamically-linked glibc binary just runs.
ARG BUZZ_REV=014562c063eae6ab1b7c6e3d20f2be3024c5f3a8
FROM rust:1-slim-bookworm AS buzz-cli
ARG BUZZ_REV
RUN apt-get update \
  && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init . \
 && git remote add origin https://github.com/block/buzz \
 && git fetch --depth 1 origin ${BUZZ_REV} \
 && git checkout FETCH_HEAD
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p buzz-cli \
 && cp target/release/buzz /buzz-real

# --- stage 2: autogent build -------------------------------------------------
FROM node:22-slim AS build
# node-gyp toolchain: better-sqlite3 compiles from source when no prebuilt
# binary matches (slim image ships none of these). Build stage only — the
# runtime stage copies the compiled node_modules and stays toolchain-free.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
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

# The real buzz CLI lives outside PATH; what the model's bash finds under
# `buzz` is the shim, which brokers through the harness (key never enters the
# bash environment). See src/tools/buzz-broker.ts.
COPY --from=buzz-cli /buzz-real /opt/buzz/buzz-real
COPY --chmod=755 scripts/buzz-shim.cjs /usr/local/bin/buzz

USER agent

# /data is the PVC: sealed state (identity, SQLite, pi auth.json) and the
# workspace the model's tools operate in. The bootstrap triple (AUTOGENT_NSEC,
# AUTOGENT_RELAY_URL, AUTOGENT_AUTH_TAG) arrives via the k8s Secret; the rest
# of the configuration arrives as the core config record (kind 30078) over the
# relay (§3.3).
ENV NODE_ENV=production \
    AUTOGENT_STATE_DIR=/data/state \
    AUTOGENT_CWD=/data/workspace \
    AUTOGENT_REMOTE_CONFIG=1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["run"]
