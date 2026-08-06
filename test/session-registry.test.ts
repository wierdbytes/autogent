/**
 * Session registry (remote plan §7.1): sessions are keyed per conversation,
 * always start empty in-process, get seeded with prior turns at creation, and
 * the sandbox tool allowlist must not strip the owner-managed surface —
 * extension tools and relay customTools — when it is widened into the SDK's
 * `tools` option.
 */

import { describe, expect, it } from "vitest";
import { SessionRegistry, sessionKeyFor } from "../src/runtime/session-registry.js";
import { nullLogger } from "../src/runtime/logger.js";
import type { ChannelRepository } from "../src/runtime/ports.js";

function channelsStub(): ChannelRepository {
  return {
    upsert: () => {},
    get: () => undefined,
    active: () => [],
    setStatus: () => {},
    setPiSession: () => {},
    setLastSeen: () => {},
  };
}

interface FakeSdkOptions {
  extensionTools?: Map<string, string[]>;
  capture?: (options: Record<string, unknown>) => void;
  captureLoader?: (options: Record<string, unknown>) => void;
  /** Transcript entries appended before session creation, per open. */
  appended?: Array<Record<string, unknown>>;
  /** Custom messages injected into the live session. */
  injected?: Array<Record<string, unknown>>;
  withLoader?: boolean;
}

function fakeSdk(options: FakeSdkOptions = {}) {
  const extensionTools = options.extensionTools ?? new Map<string, string[]>();
  const sdk: Record<string, unknown> = {
    async createAgentSession(sessionOptions: Record<string, unknown>) {
      options.capture?.(sessionOptions);
      return {
        session: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          isStreaming: false,
          isIdle: true,
          model: { provider: "anthropic", id: "claude-opus-5" },
          prompt: async () => {},
          steer: async () => {},
          abort: async () => {},
          waitForIdle: async () => {},
          subscribe: () => () => {},
          setModel: async () => {},
          sendCustomMessage: async (message: Record<string, unknown>) => {
            options.injected?.push(message);
          },
          dispose: () => {},
        },
      };
    },
    SessionManager: {
      create: () => ({
        appendMessage: (message: Record<string, unknown>) => {
          options.appended?.push(message);
          return "entry-id";
        },
      }),
      open: () => {
        throw new Error("prior transcripts must never be reopened");
      },
    },
    ModelRuntime: { create: async () => ({ getModel: () => ({}) }) },
  };
  if (options.withLoader !== false) {
    sdk["DefaultResourceLoader"] = class {
      constructor(private readonly loaderOptions: Record<string, unknown>) {
        options.captureLoader?.(loaderOptions);
      }
      async reload(): Promise<void> {}
      getExtensions() {
        return {
          extensions: [...extensionTools.entries()].map(([path, tools]) => ({
            path,
            tools: new Map(tools.map((name) => [name, {}])),
          })),
        };
      }
    };
  }
  return sdk;
}

function makeRegistry(sdk: Record<string, unknown>, config: Record<string, unknown> = {}) {
  return new SessionRegistry({
    config: { cwd: "/tmp/workspace", ...config },
    channels: channelsStub(),
    relayId: "relay",
    logger: nullLogger,
    loadSdk: async () => sdk as never,
  });
}

describe("session keys", () => {
  it("keys channel-level and thread conversations apart", () => {
    expect(sessionKeyFor("chan", null)).toBe("chan");
    expect(sessionKeyFor("chan", "a".repeat(64))).toBe(`chan::${"a".repeat(64)}`);
  });
});

describe("session lifecycle", () => {
  it("never reopens a prior on-disk transcript", async () => {
    // fakeSdk's SessionManager.open throws; opening must go through create.
    const registry = makeRegistry(fakeSdk());
    const session = await registry.acquire("channel-1");
    expect(session.sessionId).toBe("session-1");
  });

  it("reports no history on a fresh session until the first prompt", async () => {
    const registry = makeRegistry(fakeSdk());
    const session = await registry.acquire("channel-1");
    expect(session.hasHistory).toBe(false);

    await session.prompt("hello");
    expect(session.hasHistory).toBe(true);
  });

  it("caches sessions per key and separates thread sessions", async () => {
    const registry = makeRegistry(fakeSdk());
    const channel = await registry.acquire("channel-1");
    const thread = await registry.acquire(`channel-1::${"b".repeat(64)}`);
    expect(await registry.acquire("channel-1")).toBe(channel);
    expect(thread).not.toBe(channel);
  });

  it("releaseForChannel drops the channel session and all its thread sessions", async () => {
    const registry = makeRegistry(fakeSdk());
    const channel = await registry.acquire("channel-1");
    const thread = await registry.acquire(`channel-1::${"b".repeat(64)}`);
    const other = await registry.acquire("channel-2");

    await registry.releaseForChannel("channel-1");

    expect(channel.disposed).toBe(true);
    expect(thread.disposed).toBe(true);
    expect(other.disposed).toBe(false);
    // A new acquire builds a fresh session rather than returning the disposed one.
    expect(await registry.acquire("channel-1")).not.toBe(channel);
  });
});

describe("session seeding", () => {
  it("appends seed messages to the transcript before the session opens", async () => {
    const appended: Array<Record<string, unknown>> = [];
    const registry = makeRegistry(fakeSdk({ appended }));

    const session = await registry.acquire("channel-1", {
      seed: async () => [
        { role: "user", content: "From: @alice\nContent:\nhi", timestampMs: 1_000 },
        { role: "assistant", content: "hello alice", timestampMs: 2_000 },
      ],
    });

    expect(appended).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "From: @alice\nContent:\nhi" }],
        timestamp: 1_000,
      },
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "hello alice" }],
        stopReason: "stop",
        timestamp: 2_000,
      }),
    ]);
    // A seeded transcript counts as history from the start.
    expect(session.hasHistory).toBe(true);
  });

  it("skips the seed callback for cached sessions", async () => {
    const registry = makeRegistry(fakeSdk());
    let seeds = 0;
    const seed = async () => {
      seeds += 1;
      return [];
    };
    await registry.acquire("channel-1", { seed });
    await registry.acquire("channel-1", { seed });
    expect(seeds).toBe(1);
  });

  it("injects context messages into a live session without starting a turn", async () => {
    const injected: Array<Record<string, unknown>> = [];
    const registry = makeRegistry(fakeSdk({ injected }));
    const session = await registry.acquire("channel-1");

    await session.injectContext("From: @bob\nContent:\nmissed this");

    expect(injected).toEqual([
      { customType: "buzz-context", content: "From: @bob\nContent:\nmissed this", display: false },
    ]);
  });
});

describe("system prompt shaping", () => {
  it("always builds a resource loader carrying the prompt shaper", async () => {
    let loaderOptions: Record<string, unknown> = {};
    const registry = makeRegistry(
      fakeSdk({
        captureLoader: (options) => {
          loaderOptions = options;
        },
      }),
    );
    await registry.acquire("channel-1", { contextLines: ["Scope: channel"] });

    const factories = loaderOptions["extensionFactories"] as unknown[];
    expect(factories).toHaveLength(1);
    expect(typeof factories[0]).toBe("function");
  });

  it("injects the builtin prelude ahead of the owner's appendSystemPrompt", async () => {
    let loaderOptions: Record<string, unknown> = {};
    const registry = new SessionRegistry({
      config: { cwd: "/tmp/workspace", appendSystemPrompt: "owner instructions" },
      channels: channelsStub(),
      relayId: "relay",
      logger: nullLogger,
      systemPromptPrelude: () => ["## Buzz CLI\nbuiltin usage"],
      loadSdk: async () =>
        fakeSdk({
          captureLoader: (options) => {
            loaderOptions = options;
          },
        }) as never,
    });

    await registry.acquire("channel-1");

    expect(loaderOptions["appendSystemPrompt"]).toEqual([
      "## Buzz CLI\nbuiltin usage",
      "owner instructions",
    ]);
  });
});

describe("SessionRegistry tool allowlist", () => {
  it("widens the sandbox allowlist with extension and relay tool names", async () => {
    let captured: Record<string, unknown> = {};
    const registry = new SessionRegistry({
      config: {
        cwd: "/tmp/workspace",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        extensions: ["npm:@wierdbytes/pi-web"],
      },
      channels: channelsStub(),
      relayId: "relay",
      logger: nullLogger,
      customTools: [{ name: "send_message" }, { name: "channel_history" }],
      loadSdk: async () =>
        fakeSdk({
          extensionTools: new Map([["/ext/pi-web", ["web_search", "web_fetch"]]]),
          capture: (options) => {
            captured = options;
          },
        }) as never,
    });

    await registry.acquire("channel-1");

    expect(captured["tools"]).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "web_search",
      "web_fetch",
      "send_message",
      "channel_history",
    ]);
  });

  it("widens the allowlist with relay tools even without a resource loader", async () => {
    // An SDK without DefaultResourceLoader (minimal fakes) still needs the
    // relay customTools to reach the model.
    let captured: Record<string, unknown> = {};
    const registry = new SessionRegistry({
      config: {
        cwd: "/tmp/workspace",
        tools: ["read", "bash"],
      },
      channels: channelsStub(),
      relayId: "relay",
      logger: nullLogger,
      customTools: [{ name: "send_message" }],
      loadSdk: async () =>
        fakeSdk({
          withLoader: false,
          capture: (options) => {
            captured = options;
          },
        }) as never,
    });

    await registry.acquire("channel-1");

    expect(captured["resourceLoader"]).toBeUndefined();
    expect(captured["tools"]).toEqual(["read", "bash", "send_message"]);
  });

  it("leaves sessions without an allowlist unrestricted", async () => {
    let captured: Record<string, unknown> = {};
    const registry = new SessionRegistry({
      config: { cwd: "/tmp/workspace", extensions: ["npm:@wierdbytes/pi-web"] },
      channels: channelsStub(),
      relayId: "relay",
      logger: nullLogger,
      loadSdk: async () =>
        fakeSdk({
          extensionTools: new Map([["/ext/pi-web", ["web_search"]]]),
          capture: (options) => {
            captured = options;
          },
        }) as never,
    });

    await registry.acquire("channel-1");

    expect(captured["tools"]).toBeUndefined();
    expect(captured["resourceLoader"]).toBeDefined();
  });
});
