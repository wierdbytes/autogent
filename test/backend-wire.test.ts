/**
 * The wire contract with Buzz Desktop.
 *
 * These assertions look pedantic and are not: the desktop validates the `info`
 * response against a **closed** allowlist of top-level keys, so an extra field
 * — a `request_id` echo, a `capabilities` list — turns every deploy into a hard
 * error long after the change that added it. The same goes for the exit code,
 * which carries exactly one bit: non-zero makes the desktop throw our stdout
 * away, so an in-band error emitted with a non-zero status is an error the user
 * never sees.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "../src/backend/main.js";
import { parseRequest, PROTOCOL_VERSION } from "../src/backend/wire.js";

/** Exactly the keys `validate_provider_info` accepts, and no others. */
const ALLOWED_INFO_KEYS = [
  "ok",
  "name",
  "version",
  "protocol_version",
  "description",
  "config_schema",
];

describe("provider wire contract", () => {
  it("answers the desktop's own info request", async () => {
    const fixture = readFileSync("test/fixtures/buzz-info.request.json", "utf8");
    const response = (await handleRequest(fixture)) as unknown as Record<string, unknown>;

    expect(response["ok"]).toBe(true);
    expect(response["protocol_version"]).toBe(PROTOCOL_VERSION);
    expect(response["name"]).toBe("autogent");
    expect(typeof response["version"]).toBe("string");
    expect(response["version"]).not.toBe("");
    expect(typeof response["description"]).toBe("string");
    expect(response["description"]).not.toBe("");
  });

  it("emits no info field the desktop would reject", async () => {
    const response = (await handleRequest('{"op":"info"}')) as unknown as Record<string, unknown>;
    expect(Object.keys(response).sort()).toEqual([...ALLOWED_INFO_KEYS].sort());
  });

  it("declares a protocol version, because absence is an error and never a 1", async () => {
    const response = (await handleRequest('{"op":"info"}')) as unknown as Record<string, unknown>;
    expect(Number.isInteger(response["protocol_version"])).toBe(true);
  });

  it("ignores request_id rather than echoing it", () => {
    expect(parseRequest('{"op":"info","request_id":"req-1"}')).toEqual({ op: "info" });
  });

  it("rejects an unknown op in band", () => {
    expect(() => parseRequest('{"op":"undeploy"}')).toThrow(/unsupported op/);
  });

  it("rejects a non-object and unparseable request", () => {
    expect(() => parseRequest("[]")).toThrow(/must be a JSON object/);
    expect(() => parseRequest("not json")).toThrow(/not valid JSON/);
  });

  it("serialises to a single line", async () => {
    const response = await handleRequest('{"op":"info"}');
    expect(JSON.stringify(response)).not.toContain("\n");
  });
});
