/**
 * One in-memory Pi session per conversation (plan §7.1).
 *
 * A conversation is either a whole channel (top-level messages, DMs) or a
 * single thread (`channelId::threadRootId`). Sessions are always created
 * empty in this process — on-disk transcripts from previous runs are never
 * reopened. Continuity comes from seeding instead: when a session is created,
 * the caller supplies the conversation's prior messages and they are appended
 * to the fresh transcript as real `user`/`assistant` turns before the first
 * prompt.
 *
 * Thread isolation is *not* done here — it is the scheduler's job: only the
 * active conversation may steer a running turn, other conversations wait.
 *
 * This module is the only place that touches the Pi SDK, so everything else
 * can be tested against {@link AgentSessionHandle}.
 */

import type { PiConfig } from "../config.js";
import { systemPromptShaperExtension } from "../prompts/system-prompt-shaper.js";
import type {
  AcquireSessionOptions,
  AgentSessionHandle,
  ChannelRepository,
  Logger,
  PiEvent,
  SessionRegistryPort,
  SessionSeedMessage,
} from "./ports.js";
import { PiEventRouter } from "./pi-event-router.js";

/** Separator between channel id and thread root in a session key. */
export const SESSION_KEY_SEPARATOR = "::";

/** Builds the registry key for a conversation. */
export function sessionKeyFor(channelId: string, threadRootId: string | null): string {
  return threadRootId ? `${channelId}${SESSION_KEY_SEPARATOR}${threadRootId}` : channelId;
}

function channelIdOfKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(SESSION_KEY_SEPARATOR);
  return separator === -1 ? sessionKey : sessionKey.slice(0, separator);
}

/** Structural subset of the SDK's `AgentSession`, to avoid a hard type import. */
interface SdkSession {
  sessionId: string;
  sessionFile: string | undefined;
  isStreaming: boolean;
  isIdle: boolean;
  model: { id?: string; provider?: string; contextWindow?: number } | undefined;
  /** `get systemPrompt(): string` in the real SDK; optional so fakes stay minimal. */
  systemPrompt?: string;
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  setModel(model: unknown): Promise<void>;
  /**
   * Appends a custom (user-role) message without necessarily starting a turn.
   * Present in the real SDK; optional so fakes stay minimal.
   */
  sendCustomMessage?(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ): Promise<void>;
  dispose(): void;
}

/** The slice of the SDK's `SessionManager` instance used for seeding. */
interface SdkSessionManager {
  appendMessage(message: Record<string, unknown>): string;
}

interface SdkModule {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: SdkSession }>;
  SessionManager: {
    create(cwd: string, sessionDir?: string): unknown;
    open(path: string, sessionDir?: string): unknown;
  };
  ModelRuntime: { create(): Promise<{ getModel(provider: string, id: string): unknown }> };
  /** Present in the real SDK; optional so test fakes stay minimal. */
  DefaultResourceLoader?: new (options: Record<string, unknown>) => {
    reload(): Promise<void>;
    /** Names of the loaded extension tools, keyed by extension. */
    getExtensions(): {
      extensions: Array<{ tools: Map<string, unknown> | Record<string, unknown> }>;
    };
  };
}

/** Zero-filled usage block for synthetic seeded assistant messages. */
const SEED_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A seeded message as the SDK transcript stores it. */
function seedEntryOf(message: SessionSeedMessage): Record<string, unknown> {
  if (message.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: message.content }],
      timestamp: message.timestampMs,
    };
  }
  // Assistant entries need provider metadata structurally; the placeholders
  // are never sent back to a provider — only the text content participates in
  // the LLM context.
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: "seed",
    provider: "seed",
    model: "seed",
    usage: SEED_USAGE,
    stopReason: "stop",
    timestamp: message.timestampMs,
  };
}

/**
 * Adapts an SDK session to {@link AgentSessionHandle}.
 *
 * The event router lives here so each session gets its own message-id sequence.
 */
class PiSessionAdapter implements AgentSessionHandle {
  readonly #router = new PiEventRouter();
  #disposed = false;
  readonly #seeded: boolean;
  #prompted = false;

  constructor(
    private readonly session: SdkSession,
    private readonly resolveModel: (id: string) => Promise<unknown>,
    options: { seeded: boolean },
  ) {
    this.#seeded = options.seeded;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }
  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }
  get isStreaming(): boolean {
    return this.session.isStreaming;
  }
  get isIdle(): boolean {
    return this.session.isIdle;
  }
  get model(): string | undefined {
    const model = this.session.model;
    if (!model?.id) return undefined;
    return model.provider ? `${model.provider}/${model.id}` : model.id;
  }
  /** The effective prompt, including per-turn extension modifications. */
  get systemPrompt(): string | undefined {
    return this.session.systemPrompt;
  }
  get contextWindow(): number | undefined {
    const window = this.session.model?.contextWindow;
    return typeof window === "number" && Number.isFinite(window) && window > 0
      ? window
      : undefined;
  }

  /** Seeded transcripts have memory from the start; empty ones after a prompt. */
  get hasHistory(): boolean {
    return this.#seeded || this.#prompted;
  }

  prompt(text: string): Promise<void> {
    this.#prompted = true;
    // Prompt templates are disabled: the text contains untrusted user content,
    // and template expansion there would be an injection vector (plan §10.2).
    return this.session.prompt(text, { source: "rpc", expandPromptTemplates: false });
  }
  steer(text: string): Promise<void> {
    return this.session.steer(text);
  }
  async injectContext(text: string): Promise<void> {
    if (!this.session.sendCustomMessage) {
      throw new Error("session does not support context injection");
    }
    await this.session.sendCustomMessage(
      { customType: "buzz-context", content: text, display: false },
      { triggerTurn: false },
    );
  }
  abort(): Promise<void> {
    return this.session.abort();
  }
  waitForIdle(): Promise<void> {
    return this.session.waitForIdle();
  }
  subscribe(listener: (event: PiEvent) => void): () => void {
    return this.session.subscribe((raw) => {
      for (const event of this.#router.translate(raw)) listener(event);
    });
  }
  async setModel(model: string): Promise<void> {
    const resolved = await this.resolveModel(model);
    if (!resolved) throw new Error(`unknown model: ${model}`);
    await this.session.setModel(resolved);
  }
  get disposed(): boolean {
    return this.#disposed;
  }
  dispose(): void {
    this.#disposed = true;
    this.session.dispose();
  }
}

export interface SessionRegistryDeps {
  config: PiConfig;
  channels: ChannelRepository;
  relayId: string;
  logger: Logger;
  /**
   * Harness tools registered on every session as the SDK's `customTools`.
   * Opaque here — the registry does not interpret them.
   */
  customTools?: unknown[];
  /**
   * Built-in system prompts injected *before* the owner's
   * `appendSystemPrompt` (buzz-cli plan §5). A closure so a hot config flip
   * (e.g. `buzz_cli.enabled`) binds on the next session open without new
   * wiring; called once per session open.
   */
  systemPromptPrelude?: () => readonly string[];
  /** Injected for tests; defaults to importing the real SDK. */
  loadSdk?: () => Promise<SdkModule>;
}

async function defaultLoadSdk(): Promise<SdkModule> {
  return (await import("@earendil-works/pi-coding-agent")) as unknown as SdkModule;
}

export class SessionRegistry implements SessionRegistryPort {
  readonly #sessions = new Map<string, AgentSessionHandle>();
  #sdk: SdkModule | null = null;
  #modelRuntime: { getModel(provider: string, id: string): unknown } | null = null;
  #config: PiConfig;

  constructor(private readonly deps: SessionRegistryDeps) {
    this.#config = { ...deps.config };
  }

  /**
   * Applies a core-record config change (remote plan §3.3).
   *
   * New sessions pick the new parameters up immediately; live sessions are
   * dropped from memory here and rebuilt (reseeded from the relay) on the
   * conversation's next turn — so a config push never aborts a running turn.
   */
  async applyConfig(update: Partial<PiConfig>): Promise<void> {
    this.#config = { ...this.#config, ...update };
    for (const [sessionKey, session] of [...this.#sessions.entries()]) {
      if (session.isStreaming) continue; // picked up on the next acquire after release
      this.#sessions.delete(sessionKey);
      session.dispose();
    }
  }

  async acquire(sessionKey: string, options?: AcquireSessionOptions): Promise<AgentSessionHandle> {
    const existing = this.#sessions.get(sessionKey);
    if (existing) return existing;
    const handle = await this.#open(sessionKey, options);
    this.#sessions.set(sessionKey, handle);
    return handle;
  }

  async release(sessionKey: string): Promise<void> {
    const session = this.#sessions.get(sessionKey);
    if (!session) return;
    this.#sessions.delete(sessionKey);
    session.dispose();
  }

  async releaseForChannel(channelId: string): Promise<void> {
    for (const sessionKey of [...this.#sessions.keys()]) {
      if (channelIdOfKey(sessionKey) === channelId) await this.release(sessionKey);
    }
  }

  async disposeAll(): Promise<void> {
    for (const sessionKey of [...this.#sessions.keys()]) {
      await this.release(sessionKey);
    }
  }

  async #sdkModule(): Promise<SdkModule> {
    if (!this.#sdk) this.#sdk = await (this.deps.loadSdk ?? defaultLoadSdk)();
    return this.#sdk;
  }

  /**
   * Opens a fresh session for the conversation.
   *
   * Prior-run transcripts on disk are deliberately not reopened: the seed
   * callback rebuilds the conversation from the relay, which is the durable
   * source of truth for what was actually said.
   */
  async #open(sessionKey: string, options?: AcquireSessionOptions): Promise<AgentSessionHandle> {
    const sdk = await this.#sdkModule();
    const config = this.#config;

    const sessionManager = sdk.SessionManager.create(config.cwd);

    // Seed the transcript before the SDK session exists, so the agent loads
    // the conversation as ordinary context on its first turn.
    const seedMessages = options?.seed ? await options.seed() : [];
    if (seedMessages.length > 0) {
      const manager = sessionManager as SdkSessionManager;
      for (const message of seedMessages) manager.appendMessage(seedEntryOf(message));
    }

    const model = config.model ? await this.#resolveModel(config.model) : undefined;

    // Extra system prompts, the prompt shaper and extension sources travel
    // through a resource loader; createAgentSession has no direct option for
    // any of them. The builtin prelude (buzz CLI usage) goes ahead of the
    // owner's appendSystemPrompt so the owner's instructions read as the more
    // specific, later word. Extension sources may be `npm:`/`git:` specifiers
    // — the loader's package manager resolves (and installs) them.
    let resourceLoader: InstanceType<NonNullable<SdkModule["DefaultResourceLoader"]>> | undefined;
    const extensions = config.extensions ?? [];
    const appendPrompts = [
      ...(this.deps.systemPromptPrelude?.() ?? []),
      ...(config.appendSystemPrompt ? [config.appendSystemPrompt] : []),
    ];
    const contextLines = options?.contextLines ?? [];
    if (sdk.DefaultResourceLoader) {
      resourceLoader = new sdk.DefaultResourceLoader({
        cwd: config.cwd,
        agentDir: config.agentDir,
        ...(appendPrompts.length > 0 ? { appendSystemPrompt: appendPrompts } : {}),
        ...(extensions.length > 0 ? { additionalExtensionPaths: extensions } : {}),
        // Reshapes the assembled system prompt per turn: drops the SDK's
        // Guidelines / Pi documentation sections and inserts the conversation
        // context below `Current working directory`.
        extensionFactories: [systemPromptShaperExtension(contextLines)],
      });
      await resourceLoader.reload();
    }

    // The sandbox allowlist speaks built-in tool names only; handed to the SDK
    // as-is it would silently strip the owner-managed surface — extension
    // tools and harness customTools — from every session (the SDK drops
    // anything an allowlist does not name). Widen it with the names actually
    // loaded; switching individual tools off stays an excludeTools job. Note
    // this must not depend on the resource loader: profiles without extra
    // prompts or extensions never build one, yet their customTools still need
    // naming in the allowlist.
    let tools = config.tools;
    if (tools) {
      const extensionTools = resourceLoader
        ? resourceLoader
            .getExtensions()
            .extensions.flatMap((extension) =>
              extension.tools instanceof Map
                ? [...extension.tools.keys()]
                : Object.keys(extension.tools ?? {}),
            )
        : [];
      const customTools = (this.deps.customTools ?? [])
        .map((tool) => (tool as { name?: string } | null)?.name)
        .filter((name): name is string => typeof name === "string");
      tools = [...new Set([...tools, ...extensionTools, ...customTools])];
    }

    const { session } = await sdk.createAgentSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      sessionManager,
      ...(model ? { model } : {}),
      ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      ...(tools ? { tools } : {}),
      ...(config.excludeTools ? { excludeTools: config.excludeTools } : {}),
      ...(resourceLoader ? { resourceLoader } : {}),
      ...(this.deps.customTools && this.deps.customTools.length > 0
        ? { customTools: this.deps.customTools }
        : {}),
    });

    // Recorded for observability only — the path is never reopened.
    this.deps.channels.setPiSession(
      this.deps.relayId,
      channelIdOfKey(sessionKey),
      session.sessionId,
      session.sessionFile ?? null,
    );
    this.deps.logger.info("pi session ready", {
      sessionKey,
      sessionId: session.sessionId,
      seeded: seedMessages.length,
    });

    return new PiSessionAdapter(session, (id) => this.#resolveModel(id), {
      seeded: seedMessages.length > 0,
    });
  }

  /** Accepts `provider/model` and bare model ids. */
  async #resolveModel(id: string): Promise<unknown> {
    const sdk = await this.#sdkModule();
    if (!this.#modelRuntime) this.#modelRuntime = await sdk.ModelRuntime.create();
    const slash = id.indexOf("/");
    if (slash === -1) return undefined;
    return this.#modelRuntime.getModel(id.slice(0, slash), id.slice(slash + 1));
  }
}
