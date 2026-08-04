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
  model: { id?: string; provider?: string } | undefined;
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
}

/**
 * Adapts an SDK session to {@link AgentSessionHandle}.
 *
 * The event router lives here so each session gets its own message-id sequence.
 */
class PiSessionAdapter implements AgentSessionHandle {
  readonly #router = new PiEventRouter();

  constructor(
    private readonly session: SdkSession,
    private readonly resolveModel: (id: string) => Promise<unknown>,
  ) {}

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

  prompt(text: string): Promise<void> {
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
  dispose(): void {
    this.session.dispose();
  }
}

export interface SessionRegistryDeps {
  config: PiConfig;
  channels: ChannelRepository;
  relayId: string;
  logger: Logger;
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

  constructor(private readonly deps: SessionRegistryDeps) {}

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
    const record = this.deps.channels.get(this.deps.relayId, channelId);
    const priorPath = options.fresh ? null : record?.piSessionPath;

    const sessionManager = priorPath
      ? sdk.SessionManager.open(priorPath)
      : sdk.SessionManager.create(this.deps.config.cwd);

    const model = this.deps.config.model
      ? await this.#resolveModel(this.deps.config.model)
      : undefined;

    const { session } = await sdk.createAgentSession({
      cwd: this.deps.config.cwd,
      agentDir: this.deps.config.agentDir,
      sessionManager,
      ...(model ? { model } : {}),
      ...(this.deps.config.thinkingLevel ? { thinkingLevel: this.deps.config.thinkingLevel } : {}),
      ...(this.deps.config.tools ? { tools: this.deps.config.tools } : {}),
      ...(this.deps.config.excludeTools ? { excludeTools: this.deps.config.excludeTools } : {}),
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
      reused: Boolean(priorPath),
    });

    return new PiSessionAdapter(session, (id) => this.#resolveModel(id));
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
