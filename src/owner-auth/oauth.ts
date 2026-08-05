/**
 * Interactive provider-credential login, shared by `autogent-nostr auth login`
 * and the interactive `autogent` wizard's mandatory login step.
 *
 * The flows themselves are pi's (`ModelRuntime.login`), pointed at a
 * caller-chosen `authPath` so the credential lands in exactly the file shape
 * the remote harness materialises from the `autogent/auth` record. Every
 * provider pi supports works here — OAuth subscriptions (Anthropic, ChatGPT,
 * GitHub Copilot, OpenRouter, …) and interactive API-key setup — and the
 * credential file is multi-provider by construction
 * (`Record<providerId, Credential>`).
 */

import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";

export type LoginAuthType = "oauth" | "api_key";

interface SdkPrompt {
  type: string;
  message: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

interface SdkRuntime {
  getProviders(): readonly {
    id: string;
    name: string;
    auth: {
      oauth?: { name: string; loginLabel?: string };
      apiKey?: { name: string; login?: unknown };
    };
  }[];
  login(
    providerId: string,
    type: LoginAuthType,
    interaction: {
      prompt(prompt: SdkPrompt): Promise<string>;
      notify(event: Record<string, unknown>): void;
    },
  ): Promise<unknown>;
}

interface SdkAuthModule {
  ModelRuntime: {
    create(options: { authPath: string }): Promise<SdkRuntime>;
  };
}

async function createRuntime(authPath: string): Promise<SdkRuntime> {
  const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as SdkAuthModule;
  return sdk.ModelRuntime.create({ authPath });
}

export interface LoginChoice {
  providerId: string;
  type: LoginAuthType;
  /** Human label, e.g. "Anthropic (Claude Pro/Max)" or "OpenAI API key". */
  label: string;
}

/**
 * Enumerates every interactive login pi supports at this `authPath`:
 * OAuth flows first, then API-key setups. Ambient-only api-key providers
 * (env vars, AWS profiles — no interactive `login`) are excluded.
 */
export async function listLoginChoices(authPath: string): Promise<LoginChoice[]> {
  const runtime = await createRuntime(authPath);
  const oauth: LoginChoice[] = [];
  const apiKey: LoginChoice[] = [];
  for (const provider of runtime.getProviders()) {
    if (provider.auth.oauth) {
      oauth.push({ providerId: provider.id, type: "oauth", label: provider.auth.oauth.name });
    }
    if (provider.auth.apiKey?.login) {
      apiKey.push({ providerId: provider.id, type: "api_key", label: provider.auth.apiKey.name });
    }
  }
  const byLabel = (a: LoginChoice, b: LoginChoice) => a.label.localeCompare(b.label);
  return [...oauth.sort(byLabel), ...apiKey.sort(byLabel)];
}

/**
 * Opens a URL in the platform's default browser — pi's own launcher,
 * replicated because the package does not export it (`exports` allows only
 * the root entry). Intentionally never invokes a shell: on Windows,
 * `cmd /c start` re-parses metacharacters before `start` runs, which would
 * make attacker-controlled URLs injectable. Launch is best-effort — the URL
 * is always printed as well, so a missing launcher must not crash the flow.
 */
function openBrowser(target: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

function notifyToStdout(event: Record<string, unknown>): void {
  switch (event["type"]) {
    case "auth_url": {
      const url = String(event["url"]);
      process.stdout.write(`\nOpening your browser to authorise (or open manually):\n  ${url}\n`);
      if (event["instructions"]) process.stdout.write(`${String(event["instructions"])}\n`);
      openBrowser(url);
      return;
    }
    case "device_code": {
      process.stdout.write(
        `\nOpen ${String(event["verificationUri"])} and enter code:\n  ${String(event["userCode"])}\n`,
      );
      return;
    }
    case "info":
    case "progress": {
      process.stdout.write(`${String(event["message"])}\n`);
      const links = event["links"];
      if (Array.isArray(links)) {
        for (const link of links as { url?: unknown; label?: unknown }[]) {
          process.stdout.write(`  ${link.label ? `${String(link.label)}: ` : ""}${String(link.url)}\n`);
        }
      }
      return;
    }
    default:
      return;
  }
}

async function promptViaReadline(rl: Interface, prompt: SdkPrompt): Promise<string> {
  if (prompt.type === "select" && prompt.options && prompt.options.length > 0) {
    process.stdout.write(`${prompt.message}\n`);
    prompt.options.forEach((option, index) => {
      const description = option.description ? ` — ${option.description}` : "";
      process.stdout.write(`  ${index + 1}. ${option.label}${description}\n`);
    });
    for (;;) {
      const answer = (await rl.question("> ")).trim();
      const byIndex = prompt.options[Number(answer) - 1];
      if (byIndex) return byIndex.id;
      const byId = prompt.options.find((option) => option.id === answer);
      if (byId) return byId.id;
      process.stdout.write(`enter a number between 1 and ${prompt.options.length}\n`);
    }
  }
  // text | secret | manual_code: a plain line read. Secrets echo in the
  // terminal — acceptable for an owner-side CLI, same trade-off pi's CLI makes.
  return (await rl.question(`${prompt.message}\n> `)).trim();
}

/**
 * Runs pi's interactive login for one provider/auth-type pair, writing the
 * credential into `authPath` alongside whatever other providers are stored.
 */
export async function runProviderLogin(
  authPath: string,
  providerId: string,
  type: LoginAuthType,
): Promise<void> {
  const runtime = await createRuntime(authPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runtime.login(providerId, type, {
      prompt: (prompt) => promptViaReadline(rl, prompt),
      notify: notifyToStdout,
    });
  } finally {
    rl.close();
  }
}

/** The original Anthropic-only flow, kept for callers that pin the default. */
export async function runOAuthLogin(authPath: string): Promise<void> {
  await runProviderLogin(authPath, "anthropic", "oauth");
}
