/**
 * Git over the relay's Smart HTTP (remote plan §5.3).
 *
 * The relay authenticates every git route with NIP-98 (`Authorization:
 * Nostr <base64 event>`, `u` = the repo-root URL, `method` tag, ±60s
 * freshness). A stock `git` CLI cannot mint those, and handing the model the
 * key is out of the question — so the harness runs a **loopback auth proxy**:
 * plain `git clone http://127.0.0.1:<port>/git/<owner>/<repo>` works in the
 * bash tool, and the proxy injects a freshly signed header per request on its
 * way to the relay. The nsec never appears in the bash environment, in a
 * file, or in git config; the proxy binds 127.0.0.1 only.
 *
 * (The plan sketched a credential-helper + unix socket; the relay's `Nostr`
 * authorization scheme cannot be produced by git's Basic-auth credential
 * machinery, so the socket became a proxy — same trust shape: the harness
 * signs per request, the transport carries tokens, never keys.)
 *
 * `git_repos` handles discovery: NIP-34 kind 30617 announcements, rewritten
 * to proxy clone URLs.
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import type { AgentEventBuilder } from "../nostr/event-builder.js";
import { KIND, tagValue, type NostrEvent } from "../nostr/types.js";
import type { Clock, Logger } from "../runtime/ports.js";
import { nip98Header } from "./http-auth.js";
import { asToolError, textResult, type RelayTool, type RelayToolDeps } from "./deps.js";

const REPO_PATH = /^\/git\/([0-9a-f]{64})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(\/.*)?$/;

export interface GitAuthProxyOptions {
  upstreamOrigin: string;
  builder: AgentEventBuilder;
  clock: Clock;
  logger: Logger;
}

export class GitAuthProxy {
  #server: Server | null = null;
  #port: number | null = null;
  readonly #options: GitAuthProxyOptions;

  constructor(options: GitAuthProxyOptions) {
    this.#options = options;
  }

  get port(): number | null {
    return this.#port;
  }

  /** Starts (idempotently) and resolves the loopback port. */
  async ensureStarted(): Promise<number> {
    if (this.#port !== null) return this.#port;
    const { upstreamOrigin, builder, clock, logger } = this.#options;
    const upstream = new URL(upstreamOrigin);

    const server = createServer((incoming, outgoing) => {
      const match = REPO_PATH.exec(incoming.url ?? "");
      if (!match) {
        outgoing.writeHead(404).end("only /git/<owner>/<repo>/… is proxied");
        return;
      }
      const repoRoot = `${upstreamOrigin}/git/${match[1]}/${match[2]}`;
      const authorization = nip98Header(builder, clock, repoRoot, incoming.method ?? "GET");

      const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
      const proxied = send(
        `${upstreamOrigin}${incoming.url}`,
        {
          method: incoming.method,
          headers: {
            ...incoming.headers,
            host: upstream.host,
            authorization,
          },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      proxied.on("error", (error) => {
        logger.warn("git proxy upstream error", { error: error.message });
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("upstream error");
      });
      incoming.pipe(proxied);
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("git proxy failed to bind a loopback port");
    }
    this.#server = server;
    this.#port = address.port;
    logger.info("git auth proxy listening", { port: address.port });
    return address.port;
  }

  close(): void {
    this.#server?.close();
    this.#server = null;
    this.#port = null;
  }
}

export function gitReposTool(deps: RelayToolDeps, proxy: GitAuthProxy): RelayTool {
  return {
    name: "git_repos",
    label: "List relay git repositories",
    description:
      "Discover git repositories announced on the relay (NIP-34) and get clone URLs that work " +
      "with the plain `git` CLI in this workspace (authentication is handled transparently).",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Filter by owner pubkey (64 hex, optional)" },
      },
    },
    async execute(_id, params) {
      try {
        const owner = String(params["owner"] ?? "").trim();
        const filters = [
          {
            kinds: [KIND.GIT_REPO_ANNOUNCEMENT],
            limit: 100,
            ...(owner !== "" ? { authors: [owner] } : {}),
          },
        ];
        const events = await deps.relay.query(filters);
        if (events.length === 0) return textResult("no repositories announced on this relay");

        const port = await proxy.ensureStarted();
        const lines = dedupeByAddress(events).map((event) => {
          const name = tagValue(event, "d") ?? "(unnamed)";
          const description = tagValue(event, "description") ?? "";
          const cloneUrl = `http://127.0.0.1:${port}/git/${event.pubkey}/${name}`;
          return `${name} — owner ${event.pubkey.slice(0, 12)}…${description ? `\n  ${description}` : ""}\n  clone: git clone ${cloneUrl}`;
        });
        return textResult(lines.join("\n"), { count: lines.length });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}

/** Announcements are replaceable by (author, d); keep the newest of each. */
function dedupeByAddress(events: NostrEvent[]): NostrEvent[] {
  const byAddress = new Map<string, NostrEvent>();
  for (const event of events) {
    const address = `${event.pubkey}:${tagValue(event, "d") ?? ""}`;
    const existing = byAddress.get(address);
    if (!existing || existing.created_at < event.created_at) byAddress.set(address, event);
  }
  return [...byAddress.values()];
}
