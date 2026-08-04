#!/usr/bin/env node
/**
 * A minimal NIP-01/NIP-42 relay, for verifying a local deploy end to end.
 *
 * It exists so `buzz-backend-autogent` can be exercised against a *real*
 * socket: the provider only reports success once the agent logs "agent online",
 * and the agent only logs that after it has connected, authenticated, published
 * its profile and subscribed. Without a relay the happy path is unreachable, and
 * an untested happy path is the one that breaks.
 *
 * This is a development fixture, not a relay. It accepts every event from every
 * key, stores them in memory, and implements just enough filter matching to
 * answer a subscription. Do not point anything real at it.
 *
 *   node scripts/dev-relay.mjs [--port 3000]
 */

import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";

const port = Number(
  process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 3000,
);

/** Every event ever received, in arrival order. */
const store = [];
/** socket → Map<subId, filters> */
const subscriptions = new Map();

function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const name = key.slice(1);
    const present = event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
    if (!values.some((value) => present.includes(value))) return false;
  }
  return true;
}

function send(socket, frame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

const server = new WebSocketServer({ port });

server.on("connection", (socket) => {
  subscriptions.set(socket, new Map());
  // Relays send the challenge immediately; the agent buffers it if it is not
  // yet waiting for one.
  send(socket, ["AUTH", randomBytes(16).toString("hex")]);

  socket.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    const [verb] = frame;

    if (verb === "AUTH") {
      const event = frame[1];
      process.stdout.write(`auth   ${event.pubkey.slice(0, 12)}…\n`);
      send(socket, ["OK", event.id, true, ""]);
      return;
    }

    if (verb === "EVENT") {
      const event = frame[1];
      store.push(event);
      send(socket, ["OK", event.id, true, ""]);
      process.stdout.write(`event  kind=${event.kind} from=${event.pubkey.slice(0, 12)}…\n`);
      for (const [peer, subs] of subscriptions) {
        for (const [subId, filters] of subs) {
          if (filters.some((filter) => matches(filter, event))) {
            send(peer, ["EVENT", subId, event]);
          }
        }
      }
      return;
    }

    if (verb === "REQ") {
      const [, subId, ...filters] = frame;
      subscriptions.get(socket)?.set(subId, filters);
      for (const event of store) {
        if (filters.some((filter) => matches(filter, event))) {
          send(socket, ["EVENT", subId, event]);
        }
      }
      send(socket, ["EOSE", subId]);
      process.stdout.write(`req    ${subId} ${JSON.stringify(filters)}\n`);
      return;
    }

    if (verb === "CLOSE") {
      subscriptions.get(socket)?.delete(frame[1]);
    }
  });

  socket.on("close", () => subscriptions.delete(socket));
});

process.stdout.write(`dev relay listening on ws://localhost:${port}\n`);
