/**
 * Relay tools (remote plan §5): membership gating, workspace confinement,
 * HTTP auth event shapes and the git auth proxy.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createEventBuilder, type AgentEventBuilder } from "../src/nostr/event-builder.js";
import { signAttestation } from "../src/nostr/nip-oa.js";
import { createSigner, verifyNostrEvent, type Signer } from "../src/nostr/signer.js";
import { KIND, tagValue, type NostrEvent } from "../src/nostr/types.js";
import { systemClock } from "../src/runtime/clock.js";
import { nullLogger } from "../src/runtime/logger.js";
import { channelHistoryTool, channelListTool, channelSearchTool } from "../src/tools/channel-tools.js";
import { httpOriginOf, type RelayToolDeps } from "../src/tools/deps.js";
import { GitAuthProxy, gitReposTool } from "../src/tools/git-tools.js";
import { blossomHeader, nip98Header } from "../src/tools/http-auth.js";
import { mediaGetTool, mediaPutTool, resolveWorkspacePath } from "../src/tools/media-tools.js";
import { sendMessageTool } from "../src/tools/send-message-tool.js";
import { FakeRelayPort } from "./helpers/fake-relay-port.js";

const CHANNEL = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHANNEL_2 = "11111111-2222-3333-4444-555555555555";
const CHANNEL_3 = "99999999-8888-7777-6666-555555555555";

interface ToolHarness {
  deps: RelayToolDeps;
  relay: FakeRelayPort;
  signer: Signer;
  builder: AgentEventBuilder;
  workspace: string;
  sent: Array<{ channelId: string; content: string; reply: { rootEventId: string } | null }>;
}

function harness(overrides: Partial<RelayToolDeps> = {}): ToolHarness {
  const agentSecret = generateSecretKey();
  const signer = createSigner(new Uint8Array(agentSecret));
  const ownerSecret = generateSecretKey();
  const authTag = signAttestation(ownerSecret, signer.publicKey, "");
  const builder = createEventBuilder({ signer, authTag, clock: systemClock });
  const relay = new FakeRelayPort();
  const workspace = mkdtempSync(join(tmpdir(), "autogent-tools-"));
  const sent: ToolHarness["sent"] = [];

  const deps: RelayToolDeps = {
    relay,
    signer,
    builder,
    clock: systemClock,
    logger: nullLogger,
    channelDirectory: () => [
      { channelId: CHANNEL, name: "LinkedIn", channelType: "stream" },
      { channelId: CHANNEL_2, name: "ops", channelType: "private" },
      { channelId: CHANNEL_3, name: "ops", channelType: "private" },
    ],
    workspaceDir: workspace,
    httpOrigin: "http://relay.local",
    maxMediaBytes: 1024 * 1024,
    sendChat: async (channelId, content, reply) => {
      sent.push({ channelId, content, reply });
      return { eventId: "e".repeat(64) };
    },
    ...overrides,
  };
  return { deps, relay, signer, builder, workspace, sent };
}

function chatEvent(content: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND.CHAT,
      created_at: createdAt,
      tags: [["h", CHANNEL]],
      content,
    },
    generateSecretKey(),
  ) as NostrEvent;
}

describe("channel tools", () => {
  let h: ToolHarness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    rmSync(h.workspace, { recursive: true, force: true });
  });

  it("refuses channels outside the membership set without leaking existence", async () => {
    const result = await channelHistoryTool(h.deps).execute("t1", { channel: "other-channel" });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/not a member/);
    // The refusal teaches the model its own memberships — nothing foreign.
    expect(text).toMatch(/known channels: LinkedIn/);
    // No relay query was attempted at all.
    expect(h.relay.subscriptions.size).toBe(0);
  });

  it("resolves a unique channel name case-insensitively", async () => {
    let seenFilter: Record<string, unknown> | undefined;
    h.relay.queryResponders.push((filters) => {
      seenFilter = filters[0] as Record<string, unknown>;
      return [];
    });
    await channelHistoryTool(h.deps).execute("t1", { channel: "linkedin" });
    expect(seenFilter).toMatchObject({ "#h": [CHANNEL] });
  });

  it("refuses an ambiguous channel name and lists the candidates", async () => {
    const result = await channelHistoryTool(h.deps).execute("t1", { channel: "ops" });
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/ambiguous/);
    expect(text).toContain(CHANNEL_2);
    expect(text).toContain(CHANNEL_3);
    expect(h.relay.subscriptions.size).toBe(0);
  });

  it("lists memberships with name, id and type", async () => {
    const result = await channelListTool(h.deps).execute("t1", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`LinkedIn — ${CHANNEL} [stream]`);
    expect(text).toContain(`ops — ${CHANNEL_2} [private]`);
  });

  it("reports an empty membership set", async () => {
    const empty = harness({ channelDirectory: () => [] });
    const result = await channelListTool(empty.deps).execute("t1", {});
    expect(result.content[0]?.text).toBe("no channel memberships");
    rmSync(empty.workspace, { recursive: true, force: true });
  });

  it("reads history oldest-first through a bounded REQ", async () => {
    h.relay.queryResponders.push(() => [chatEvent("newer", 200), chatEvent("older", 100)]);
    const result = await channelHistoryTool(h.deps).execute("t1", { channel: CHANNEL, limit: 10 });
    const text = result.content[0]?.text ?? "";
    expect(text.indexOf("older")).toBeLessThan(text.indexOf("newer"));
  });

  it("passes the NIP-50 search filter through and keeps relay relevance order", async () => {
    let seenFilter: Record<string, unknown> | undefined;
    h.relay.queryResponders.push((filters) => {
      seenFilter = filters[0] as Record<string, unknown>;
      return [chatEvent("most relevant", 100), chatEvent("less relevant", 200)];
    });
    const result = await channelSearchTool(h.deps).execute("t1", {
      channel: CHANNEL,
      query: "deploy",
    });
    expect(seenFilter).toMatchObject({ search: "deploy", "#h": [CHANNEL], kinds: [KIND.CHAT] });
    const text = result.content[0]?.text ?? "";
    expect(text.indexOf("most relevant")).toBeLessThan(text.indexOf("less relevant"));
  });

  it("refuses an empty search query", async () => {
    const result = await channelSearchTool(h.deps).execute("t1", { channel: CHANNEL, query: "  " });
    expect(result.content[0]?.text).toMatch(/empty/);
  });
});

describe("send_message", () => {
  let h: ToolHarness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    rmSync(h.workspace, { recursive: true, force: true });
  });

  it("queues into membership channels through the outbox path", async () => {
    const result = await sendMessageTool(h.deps).execute("t1", {
      channel: "LinkedIn",
      content: "cross-post",
    });
    expect(result.content[0]?.text).toMatch(/queued/);
    expect(h.sent).toEqual([{ channelId: CHANNEL, content: "cross-post", reply: null }]);
  });

  it("threads under a root when reply_to is given", async () => {
    await sendMessageTool(h.deps).execute("t1", {
      channel: CHANNEL,
      content: "reply",
      reply_to: "f".repeat(64),
    });
    expect(h.sent[0]?.reply).toEqual({ rootEventId: "f".repeat(64) });
  });

  it("refuses non-membership channels and empty bodies", async () => {
    const foreign = await sendMessageTool(h.deps).execute("t1", {
      channel: "foreign",
      content: "x",
    });
    expect(foreign.content[0]?.text).toMatch(/not a member/);
    expect(h.sent).toHaveLength(0);

    const empty = await sendMessageTool(h.deps).execute("t1", { channel: CHANNEL, content: " " });
    expect(empty.content[0]?.text).toMatch(/empty/);
  });
});

describe("workspace confinement", () => {
  it("resolves relative paths inside and refuses escapes", () => {
    expect(resolveWorkspacePath("/ws", "notes/a.png")).toBe("/ws/notes/a.png");
    expect(() => resolveWorkspacePath("/ws", "../etc/passwd")).toThrow(/outside the workspace/);
    expect(() => resolveWorkspacePath("/ws", "/etc/passwd")).toThrow(/outside the workspace/);
    expect(() => resolveWorkspacePath("/ws", "/wsevil/x")).toThrow(/outside the workspace/);
  });
});

describe("HTTP auth events", () => {
  it("mints a NIP-98 event bound to the repo root and method", () => {
    const h = harness();
    const header = nip98Header(h.builder, systemClock, "http://relay.local/git/abc/repo", "post");
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

  it("mints a Blossom event with verb, hash and expiration", () => {
    const h = harness();
    const sha = "1".repeat(64);
    const header = blossomHeader(h.builder, systemClock, "upload", sha);
    const event = JSON.parse(
      Buffer.from(header.slice("Nostr ".length), "base64").toString("utf8"),
    ) as NostrEvent;
    expect(event.kind).toBe(24242);
    expect(tagValue(event, "t")).toBe("upload");
    expect(tagValue(event, "x")).toBe(sha);
    expect(Number(tagValue(event, "expiration"))).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("media tools", () => {
  let h: ToolHarness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    rmSync(h.workspace, { recursive: true, force: true });
  });

  it("uploads a workspace file with hash binding headers", async () => {
    const path = join(h.workspace, "note.txt");
    await writeFile(path, "hello media");
    const expectedSha = createHash("sha256").update("hello media").digest("hex");

    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify({ url: `http://relay.local/media/${expectedSha}.txt` }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await mediaPutTool({ ...h.deps, fetchImpl }).execute("t1", { path: "note.txt" });
    expect(result.content[0]?.text).toMatch(expectedSha);
    expect(seen?.url).toBe("http://relay.local/upload");
    expect(seen?.headers["X-SHA-256"]).toBe(expectedSha);
    expect(seen?.headers["Authorization"]).toMatch(/^Nostr /);
  });

  it("refuses uploads over the ceiling before any network call", async () => {
    const path = join(h.workspace, "big.bin");
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024));
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const result = await mediaPutTool({ ...h.deps, fetchImpl }).execute("t1", { path: "big.bin" });
    expect(result.content[0]?.text).toMatch(/ceiling/);
    expect(called).toBe(false);
  });

  it("downloads, verifies the hash and writes into the workspace", async () => {
    const body = Buffer.from("blob bytes");
    const sha = createHash("sha256").update(body).digest("hex");
    const fetchImpl = (async () => new Response(new Uint8Array(body), { status: 200 })) as typeof fetch;

    const result = await mediaGetTool({ ...h.deps, fetchImpl }).execute("t1", {
      sha256: `${sha}.txt`,
      path: "downloaded.txt",
    });
    expect(result.content[0]?.text).toMatch(/saved 10 bytes/);
    expect(await readFile(join(h.workspace, "downloaded.txt"), "utf8")).toBe("blob bytes");
  });

  it("discards bytes that do not hash to the requested sha256", async () => {
    const sha = "2".repeat(64);
    const fetchImpl = (async () => new Response(new Uint8Array(Buffer.from("wrong")), { status: 200 })) as typeof fetch;
    const result = await mediaGetTool({ ...h.deps, fetchImpl }).execute("t1", {
      sha256: sha,
      path: "x.bin",
    });
    expect(result.content[0]?.text).toMatch(/do not hash/);
  });
});

describe("git auth proxy", () => {
  let upstream: Server;
  let upstreamPort: number;
  let received: Array<{ url: string; authorization: string | undefined; method: string }>;
  let h: ToolHarness;
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

    h = harness({ httpOrigin: `http://127.0.0.1:${upstreamPort}` });
    proxy = new GitAuthProxy({
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      builder: h.builder,
      clock: systemClock,
      logger: nullLogger,
    });
  });

  afterEach(() => {
    proxy.close();
    upstream.close();
    rmSync(h.workspace, { recursive: true, force: true });
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
    expect(event.pubkey).toBe(h.signer.publicKey);
  });

  it("rejects non-git paths outright", async () => {
    const port = await proxy.ensureStarted();
    const response = await fetch(`http://127.0.0.1:${port}/etc/passwd`);
    expect(response.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("lists announced repositories with proxy clone URLs", async () => {
    const repoOwnerSecret = generateSecretKey();
    const announcement = finalizeEvent(
      {
        kind: KIND.GIT_REPO_ANNOUNCEMENT,
        created_at: 1_700_000_000,
        tags: [
          ["d", "myrepo"],
          ["description", "test repo"],
        ],
        content: "",
      },
      repoOwnerSecret,
    ) as NostrEvent;
    h.relay.queryResponders.push(() => [announcement]);

    const result = await gitReposTool(h.deps, proxy).execute("t1", {});
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/myrepo/);
    expect(text).toMatch(new RegExp(`git clone http://127\\.0\\.0\\.1:\\d+/git/${announcement.pubkey}/myrepo`));
  });
});

describe("httpOriginOf", () => {
  it("maps ws→http and wss→https, dropping the path", () => {
    expect(httpOriginOf("ws://localhost:3000")).toBe("http://localhost:3000");
    expect(httpOriginOf("wss://relay.example/ws")).toBe("https://relay.example");
  });
});
