/**
 * Harness-side relay infrastructure: HTTP auth event shape and the git auth
 * proxy. (The former model-visible relay tools were replaced by the buzz CLI
 * — see test/buzz-broker.test.ts.)
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createEventBuilder, type AgentEventBuilder } from "../src/nostr/event-builder.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { createSigner, verifyNostrEvent, type Signer } from "../src/nostr/signer.js";
import { tagValue, type NostrEvent } from "../src/nostr/types.js";
import { systemClock } from "../src/runtime/clock.js";
import { nullLogger } from "../src/runtime/logger.js";
import { httpOriginOf } from "../src/tools/deps.js";
import { GitAuthProxy } from "../src/tools/git-tools.js";
import { nip98Header } from "../src/tools/http-auth.js";

function identity(): { signer: Signer; builder: AgentEventBuilder } {
  const signer = createSigner(new Uint8Array(generateSecretKey()));
  const authTag = signAttestation(generateSecretKey(), signer.publicKey, "");
  const builder = createEventBuilder({ signer, authTag, clock: systemClock });
  return { signer, builder };
}

describe("HTTP auth events", () => {
  it("mints a NIP-98 event bound to the repo root and method", () => {
    const { builder } = identity();
    const header = nip98Header(builder, systemClock, "http://relay.local/git/abc/repo", "post");
    expect(header).toMatch(/^Nostr /);
    const event = JSON.parse(
      Buffer.from(header.slice("Nostr ".length), "base64").toString("utf8"),
    ) as NostrEvent;
    expect(event.kind).toBe(27235);
    expect(tagValue(event, "u")).toBe("http://relay.local/git/abc/repo");
    expect(tagValue(event, "method")).toBe("POST");
    expect(verifyNostrEvent(JSON.parse(JSON.stringify(event)) as NostrEvent)).toBe(true);
    // Carries the owner attestation for relay-side permission resolution.
    expect(tagValue(event, "auth")).toBeDefined();
  });
});

describe("git auth proxy", () => {
  let upstream: Server;
  let upstreamPort: number;
  let received: Array<{ url: string; authorization: string | undefined; method: string }>;
  let signer: Signer;
  let builder: AgentEventBuilder;
  let proxy: GitAuthProxy;

  beforeEach(async () => {
    received = [];
    upstream = createServer((request, response) => {
      received.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        method: request.method ?? "",
      });
      response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      response.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as { port: number }).port;

    ({ signer, builder } = identity());
    proxy = new GitAuthProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      builder,
      clock: systemClock,
      logger: nullLogger,
    });
  });

  afterEach(() => {
    proxy.close();
    upstream.close();
  });

  it("injects a fresh NIP-98 header bound to the repo root", async () => {
    const port = await proxy.ensureStarted();
    const owner = getPublicKey(generateSecretKey());
    const response = await fetch(
      `http://127.0.0.1:${port}/git/${owner}/myrepo/info/refs?service=git-upload-pack`,
    );
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    const auth = received[0]?.authorization ?? "";
    expect(auth).toMatch(/^Nostr /);
    const event = JSON.parse(Buffer.from(auth.slice(6), "base64").toString("utf8")) as NostrEvent;
    expect(tagValue(event, "u")).toBe(`http://127.0.0.1:${upstreamPort}/git/${owner}/myrepo`);
    expect(tagValue(event, "method")).toBe("GET");
    expect(event.pubkey).toBe(signer.publicKey);
  });

  it("rejects non-git paths outright", async () => {
    const port = await proxy.ensureStarted();
    const response = await fetch(`http://127.0.0.1:${port}/etc/passwd`);
    expect(response.status).toBe(404);
    expect(received).toHaveLength(0);
  });
});

describe("httpOriginOf", () => {
  it("maps ws→http and wss→https, dropping the path", () => {
    expect(httpOriginOf("ws://localhost:3000")).toBe("http://localhost:3000");
    expect(httpOriginOf("wss://relay.example/ws")).toBe("https://relay.example");
  });
});
