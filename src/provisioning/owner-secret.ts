/**
 * Owner secret acquisition for owner-side commands.
 *
 * These commands run on the *owner's* machine, never on the agent host, so this
 * is the one place that handles a key which is not the agent's own. Nothing here
 * persists, caches, or logs the value; callers own the returned bytes and should
 * zero them once a signature exists.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { decodeSecretKey } from "../nostr/signer.js";
import { ProvisioningError } from "./identity-store.js";

export type OwnerSecretSource =
  | { from: "file"; path: string }
  | { from: "stdin"; promptText?: string }
  /**
   * Supplied directly as a command-line argument.
   *
   * Discouraged, and never the default: the value is written to shell history
   * and is readable by any process that can run `ps` for as long as the command
   * lives. Offered because unattended scripting has no terminal to prompt on.
   * Callers should surface {@link ARGV_SECRET_WARNING} when this is used.
   */
  | { from: "literal"; value: string };

export const OWNER_SECRET_PROMPT = "Owner secret key (hex or nsec1…): ";

export const ARGV_SECRET_WARNING =
  "warning: --owner-private-key puts the key in shell history and in `ps` output; " +
  "prefer the interactive prompt or --owner-secret-file";

/** Reads one line with echo suppressed, prompting on stderr so stdout stays pipeable. */
export async function readSecretFromTerminal(promptText: string): Promise<string> {
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stderr.write(promptText);
  try {
    return await new Promise<string>((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

/** Materialises the owner secret, or throws a `secret-source` error. */
export async function readOwnerSecret(
  source: OwnerSecretSource,
  readSecretLine: (promptText: string) => Promise<string> = readSecretFromTerminal,
): Promise<Uint8Array> {
  let text: string;
  switch (source.from) {
    case "file":
      try {
        text = await readFile(source.path, "utf8");
      } catch {
        throw new ProvisioningError("secret-source", `cannot read owner secret file ${source.path}`);
      }
      break;
    case "literal":
      text = source.value;
      break;
    case "stdin":
      text = await readSecretLine(source.promptText ?? OWNER_SECRET_PROMPT);
      break;
  }

  try {
    return decodeSecretKey(text);
  } catch (error) {
    throw new ProvisioningError(
      "secret-source",
      `owner secret is not a valid key: ${(error as Error).message}`,
    );
  }
}
