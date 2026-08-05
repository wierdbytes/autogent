/**
 * The wizard's model catalog: models are offered if and only if the profile's
 * auth.json holds a credential for their provider — ambient env auth on the
 * owner machine must not leak into the picker, because the deployed Pod only
 * ever receives the auth.json contents.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THINKING_LEVELS, listAuthedCatalog } from "../src/owner-auth/catalog.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "autogent-catalog-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listAuthedCatalog", () => {
  it("returns nothing when the credential file is absent or empty", async () => {
    expect(await listAuthedCatalog(join(dir, "missing", "auth.json"))).toEqual([]);

    const empty = join(dir, "empty-auth.json");
    await writeFile(empty, "{}");
    expect(await listAuthedCatalog(empty)).toEqual([]);
  }, 30_000);

  it("lists only the provider whose credential is stored, with effort levels", async () => {
    const authPath = join(dir, "anthropic-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          refresh: "refresh-1",
          access: "access-1",
          expires: 2_000_000_000_000,
        },
      }),
    );

    const catalogs = await listAuthedCatalog(authPath);
    expect(catalogs.map((catalog) => catalog.providerId)).toEqual(["anthropic"]);

    const models = catalogs[0]?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.ref).toBe(`anthropic/${model.modelId}`);
      if (model.reasoning) {
        expect(model.thinkingLevels.length).toBeGreaterThan(0);
        for (const level of model.thinkingLevels) expect(THINKING_LEVELS).toContain(level);
      } else {
        expect(model.thinkingLevels).toEqual([]);
      }
    }
    // At least one current Anthropic model reasons — the effort picker exists.
    expect(models.some((model) => model.reasoning)).toBe(true);
  }, 30_000);
});
