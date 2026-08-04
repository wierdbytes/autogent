import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = resolve("dist/cli.js");

/**
 * Exercises the real process entry, not the exported `main()`.
 *
 * The entry guard compares `import.meta.url` against `process.argv[1]`, and an
 * installed bin is a symlink — so a guard that looks correct in-process can
 * still leave the shipped binary doing nothing at all. Only running the built
 * file through a symlink catches that.
 */
describe("CLI entrypoint", () => {
  let workspace: string;
  let linked: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "pi-nostr-cli-"));
    linked = join(workspace, "autogent-nostr");
    await symlink(CLI, linked);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(CLI))("prints usage when invoked through a symlinked bin", async () => {
    const { stdout } = await run(process.execPath, [linked, "help"]);
    expect(stdout).toContain("autogent-nostr");
    expect(stdout).toContain("Usage:");
  });

  it.skipIf(!existsSync(CLI))("actually provisions when invoked through a symlink", async () => {
    const stateDir = join(workspace, "state");
    const { stdout } = await run(process.execPath, [linked, "init", "--name", "Pi Agent"], {
      env: { ...process.env, AUTOGENT_STATE_DIR: stateDir },
    });

    expect(stdout).toContain("Agent pubkey:");
    expect(stdout).toContain("Pairing request:");
    expect(existsSync(join(stateDir, "pairing-request.json"))).toBe(true);
  });

  it.skipIf(!existsSync(CLI))("reports an unknown command instead of exiting silently", async () => {
    await expect(run(process.execPath, [linked, "definitely-not-a-command"])).rejects.toMatchObject({
      code: 2,
    });
  });

  it.skipIf(!existsSync(CLI))("stays importable without running", async () => {
    const { stdout } = await run(process.execPath, [
      "--input-type=module",
      "-e",
      `import { USAGE } from ${JSON.stringify(CLI)}; process.stdout.write(USAGE.slice(0, 14));`,
    ]);
    expect(stdout).toBe("autogent-nostr");
  });
});
