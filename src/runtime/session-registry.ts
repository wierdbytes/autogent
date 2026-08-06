/**
 * One persistent Pi session per channel (plan §7.1).
 *
 * A channel keeps its context across turns, which is what makes the agent feel
 * continuous in a conversation. Thread isolation is *not* done here — it is the
 * scheduler's job: only the active thread may steer a running turn, other
 * threads wait. Splitting it that way keeps a noisy channel from fragmenting
 * into dozens of contextless sessions.
 *
 * This module is the only place that touches the Pi SDK, so everything else can
 * be tested against {@link AgentSessionHandle}.
 */

import type { PiConfig } from "../config.js";
import type {
  AgentSessionHandle,
  ChannelRepository,
  Logger,
  PiEvent,
  SessionRegistryPort,
} from "./ports.js";
import { PiEventRouter } from "./pi-event-router.js";

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
  dispose(): void;
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

/**
 * Adapts an SDK session to {@link AgentSessionHandle}.
 *
 * The event router lives here so each session gets its own message-id sequence.
 */
class PiSessionAdapter implements AgentSessionHandle {
  readonly #router = new PiEventRouter();
  #disposed = false;
  readonly #resumed: boolean;
  #prompted = false;

  constructor(
    private readonly session: SdkSession,
    private readonly resolveModel: (id: string) => Promise<unknown>,
    options: { resumed: boolean },
  ) {
    this.#resumed = options.resumed;
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

  /**
   * A resumed transcript has memory from the start; a fresh one only after its
   * first prompt. Steering is not tracked separately because it can only
   * happen mid-turn — i.e. after a prompt already flipped the flag.
   */
  get hasHistory(): boolean {
    return this.#resumed || this.#prompted;
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
   * New sessions pick the new parameters up immediately; live channel sessions
   * are recreated lazily — dropped from memory here, reopened from their
   * on-disk transcript on the channel's next turn — so a config push never
   * aborts a running turn.
   */
  async applyConfig(update: Partial<PiConfig>): Promise<void> {
    this.#config = { ...this.#config, ...update };
    for (const [channelId, session] of [...this.#sessions.entries()]) {
      if (session.isStreaming) continue; // picked up on rotation/next acquire after release
      this.#sessions.delete(channelId);
      session.dispose();
    }
  }

  async acquire(channelId: string): Promise<AgentSessionHandle> {
    const existing = this.#sessions.get(channelId);
    if (existing) return existing;
    const handle = await this.#open(channelId, { fresh: false });
    this.#sessions.set(channelId, handle);
    return handle;
  }

  async release(channelId: string): Promise<void> {
    const session = this.#sessions.get(channelId);
    if (!session) return;
    this.#sessions.delete(channelId);
    session.dispose();
  }

  async rotate(channelId: string): Promise<AgentSessionHandle> {
    await this.release(channelId);
    const handle = await this.#open(channelId, { fresh: true });
    this.#sessions.set(channelId, handle);
    return handle;
  }

  async disposeAll(): Promise<void> {
    for (const channelId of [...this.#sessions.keys()]) {
      await this.release(channelId);
    }
  }

  async #sdkModule(): Promise<SdkModule> {
    if (!this.#sdk) this.#sdk = await (this.deps.loadSdk ?? defaultLoadSdk)();
    return this.#sdk;
  }

  /**
   * Opens the channel's session, reusing the transcript on disk when we have one.
   *
   * Reusing the recorded path (rather than "most recent session for this cwd")
   * matters because several channels share one cwd; "most recent" would hand a
   * channel someone else's conversation.
   */
  async #open(channelId: string, options: { fresh: boolean }): Promise<AgentSessionHandle> {
    const sdk = await this.#sdkModule();
    const config = this.#config;
    const record = this.deps.channels.get(this.deps.relayId, channelId);
    const priorPath = options.fresh ? null : record?.piSessionPath;
    const reused = Boolean(priorPath);

    const sessionManager = priorPath
      ? sdk.SessionManager.open(priorPath)
      : sdk.SessionManager.create(config.cwd);

    const model = config.model ? await this.#resolveModel(config.model) : undefined;

    // Extra system prompts and extension sources travel through a resource
    // loader; createAgentSession has no direct option for either. The builtin
    // prelude (buzz CLI usage) goes ahead of the owner's appendSystemPrompt so
    // the owner's instructions read as the more specific, later word.
    // Extension sources may be `npm:`/`git:` specifiers — the loader's package
    // manager resolves (and installs) them.
    let resourceLoader: InstanceType<NonNullable<SdkModule["DefaultResourceLoader"]>> | undefined;
    const extensions = config.extensions ?? [];
    const appendPrompts = [
      ...(this.deps.systemPromptPrelude?.() ?? []),
      ...(config.appendSystemPrompt ? [config.appendSystemPrompt] : []),
    ];
    if ((appendPrompts.length > 0 || extensions.length > 0) && sdk.DefaultResourceLoader) {
      resourceLoader = new sdk.DefaultResourceLoader({
        cwd: config.cwd,
        agentDir: config.agentDir,
        ...(appendPrompts.length > 0 ? { appendSystemPrompt: appendPrompts } : {}),
        ...(extensions.length > 0 ? { additionalExtensionPaths: extensions } : {}),
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

    this.deps.channels.setPiSession(
      this.deps.relayId,
      channelId,
      session.sessionId,
      session.sessionFile ?? null,
    );
    this.deps.logger.info("pi session ready", {
      channelId,
      sessionId: session.sessionId,
      reused,
    });

    return new PiSessionAdapter(session, (id) => this.#resolveModel(id), { resumed: reused });
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
