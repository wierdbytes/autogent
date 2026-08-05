/**
 * The interactive Anthropic OAuth flow, shared by `autogent-nostr auth login`
 * and the interactive `autogent` wizard's mandatory login step.
 *
 * The flow itself is pi's (`ModelRuntime.login`), pointed at a caller-chosen
 * `authPath` so the credential lands in exactly the file shape the remote
 * harness materialises from the `mem/provider-auth` record.
 */

import { createInterface } from "node:readline/promises";

interface SdkAuthModule {
  ModelRuntime: {
    create(options: { authPath: string }): Promise<{
      login(
        providerId: string,
        type: "oauth",
        interaction: {
          prompt(prompt: { type: string; message: string }): Promise<string>;
          notify(event: Record<string, unknown>): void;
        },
      ): Promise<unknown>;
    }>;
  };
}

export async function runOAuthLogin(authPath: string): Promise<void> {
  const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as SdkAuthModule;
  const runtime = await sdk.ModelRuntime.create({ authPath });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runtime.login("anthropic", "oauth", {
      prompt: async (prompt) => (await rl.question(`${prompt.message}\n> `)).trim(),
      notify: (event) => {
        if (event["type"] === "auth_url") {
          process.stdout.write(`\nOpen this URL to authorise:\n  ${String(event["url"])}\n`);
          if (event["instructions"]) process.stdout.write(`${String(event["instructions"])}\n`);
          return;
        }
        if (event["type"] === "info" || event["type"] === "progress") {
          process.stdout.write(`${String(event["message"])}\n`);
        }
      },
    });
  } finally {
    rl.close();
  }
}
