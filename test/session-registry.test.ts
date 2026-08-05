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
}

function fakeSdk({ extensionTools, capture }: FakeSdkOptions) {
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
      constructor(private readonly options: Record<string, unknown>) {}
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
