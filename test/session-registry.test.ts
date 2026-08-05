/**
 * Session registry (remote plan §7.1): the sandbox tool allowlist must not
 * strip the owner-managed surface — extension tools and relay customTools —
 * when it is widened into the SDK's `tools` option.
 */

import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/runtime/session-registry.js";
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
  extensionTools: Map<string, string[]>;
  capture: (options: Record<string, unknown>) => void;
  captureLoader?: (options: Record<string, unknown>) => void;
}

function fakeSdk({ extensionTools, capture, captureLoader }: FakeSdkOptions) {
  return {
    async createAgentSession(options: Record<string, unknown>) {
      capture(options);
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
          dispose: () => {},
        },
      };
    },
    SessionManager: {
      create: () => ({}),
      open: () => ({}),
    },
    ModelRuntime: { create: async () => ({ getModel: () => ({}) }) },
    DefaultResourceLoader: class {
      constructor(private readonly options: Record<string, unknown>) {
        captureLoader?.(options);
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
    },
  };
}

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
    // Profiles with neither appendSystemPrompt nor extensions never build a
    // DefaultResourceLoader; the relay customTools must still reach the model.
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
          extensionTools: new Map(),
          capture: (options) => {
            captured = options;
          },
        }) as never,
    });

    await registry.acquire("channel-1");

    expect(captured["resourceLoader"]).toBeUndefined();
    expect(captured["tools"]).toEqual(["read", "bash", "send_message"]);
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
          extensionTools: new Map(),
          capture: () => {},
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

  it("builds a resource loader for the prelude alone, and none when it is empty", async () => {
    let captured: Record<string, unknown> = {};
    let loaderBuilt = false;
    const make = (prelude: string[]) =>
      new SessionRegistry({
        config: { cwd: "/tmp/workspace" },
        channels: channelsStub(),
        relayId: "relay",
        logger: nullLogger,
        systemPromptPrelude: () => prelude,
        loadSdk: async () =>
          fakeSdk({
            extensionTools: new Map(),
            capture: (options) => {
              captured = options;
            },
            captureLoader: () => {
              loaderBuilt = true;
            },
          }) as never,
      });

    await make(["builtin"]).acquire("channel-1");
    expect(loaderBuilt).toBe(true);
    expect(captured["resourceLoader"]).toBeDefined();

    loaderBuilt = false;
    await make([]).acquire("channel-1");
    expect(loaderBuilt).toBe(false);
    expect(captured["resourceLoader"]).toBeUndefined();
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
