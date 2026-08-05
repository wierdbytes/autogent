/**
 * Read the agent nsec from Buzz Desktop's OS keyring (remote plan §7).
 *
 * Desktop stores managed-agent keys under service `buzz-desktop` (dev builds:
 * `buzz-desktop-dev`), account `agent:<pubkey>`, value — the nsec string.
 * `autogent auth login` signs the provider-auth record with that key, which is
 * legitimate by design: the keyring on the owner machine owns the nsec in the
 * provider protocol's trust model.
 *
 * Platform tools are used rather than a native binding: `security` on macOS
 * (prompts the user for keychain consent — a feature, not a bug) and
 * `secret-tool` on Linux. A file fallback (`--nsec-file`) covers everything
 * else.
 */

import { spawn } from "node:child_process";

const KEYRING_SERVICES = ["buzz-desktop", "buzz-desktop-dev"] as const;

function runTool(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = Buffer.concat(stdout).toString("utf8").trim();
      resolve(value === "" ? null : value);
    });
  });
}

export async function readAgentNsecFromKeyring(agentPubkey: string): Promise<string | null> {
  const account = `agent:${agentPubkey}`;

  if (process.platform === "darwin") {
    for (const service of KEYRING_SERVICES) {
      const value = await runTool("security", [
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ]);
      if (value !== null) return value;
    }
    return null;
  }

  if (process.platform === "linux") {
    for (const service of KEYRING_SERVICES) {
      // The Rust keyring crate stores Secret Service items with these attributes.
      const value = await runTool("secret-tool", ["lookup", "service", service, "username", account]);
      if (value !== null) return value;
    }
    return null;
  }

  return null;
}
