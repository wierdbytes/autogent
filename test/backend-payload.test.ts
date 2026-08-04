/**
 * Payload parsing: identity derivation and the pre-mutation refusals.
 *
 * Everything here happens before a directory is created or a process is
 * spawned. That ordering is the point — a deploy that fails after sealing a key
 * or starting a process has already done the damage the check exists to
 * prevent.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateSecretKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { signAttestation, toNostrTag } from "../src/nostr/nip-oa.js";
import { createSigner, decodeSecretKey } from "../src/nostr/signer.js";
import { parseDeployPayload } from "../src/backend/payload.js";
import { mintAgent } from "./helpers/backend-request.js";

describe("deploy payload", () => {
  it("derives the agent pubkey from the nsec instead of trusting the caller", () => {
    const minted = mintAgent();
    const payload = parseDeployPayload(minted.agent);
    expect(payload.agentPubkey).toBe(minted.agentPubkey);
    expect(payload.ownerPubkey).toBe(minted.ownerPubkey);
  });

  it("refuses an empty private key rather than launching identityless (I1)", () => {
    const minted = mintAgent({ private_key_nsec: "" });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/refusing to launch/);
  });

  it("refuses a key it cannot decode", () => {
    const minted = mintAgent({ private_key_nsec: "nsec1nonsense" });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/not a usable secret key/);
  });

  it("refuses an attestation minted for a different agent key", () => {
    const other = mintAgent();
    const minted = mintAgent({ auth_tag: other.authTag });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/does not verify/);
  });

  it("refuses a self-attestation", () => {
    const secret = generateSecretKey();
    const pubkey = createSigner(Uint8Array.from(secret)).publicKey;
    // `signAttestation` refuses to mint one, so the tag is assembled by hand —
    // which is exactly how a hostile or broken caller would produce it.
    const tag = JSON.stringify(["auth", pubkey, "", "a".repeat(128)]);
    const minted = mintAgent({ private_key_nsec: nsecEncode(secret), auth_tag: tag });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/self-attested/);
  });

  it("refuses a record with no attestation, and says what to do about it", () => {
    const minted = mintAgent({ auth_tag: null });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/no NIP-OA owner attestation/);
  });

  it("refuses when launch.owner_pubkey disagrees with the attested owner", () => {
    const minted = mintAgent();
    const launch = minted.agent["launch"] as Record<string, unknown>;
    launch["owner_pubkey"] = "b".repeat(64);
    expect(() => parseDeployPayload(minted.agent)).toThrow(/disagrees with the owner/);
  });

  it("refuses conditions that do not cover what the agent must publish", () => {
    const agentSecret = generateSecretKey();
    const ownerSecret = generateSecretKey();
    const agentPubkey = createSigner(Uint8Array.from(agentSecret)).publicKey;
    // Only kind 9: the agent could not publish its profile or its presence.
    const auth = signAttestation(ownerSecret, agentPubkey, "kind=9");
    const minted = mintAgent({
      private_key_nsec: nsecEncode(agentSecret),
      auth_tag: JSON.stringify(toNostrTag(auth)),
      launch: null,
    });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/do not cover kinds/);
  });

  it("refuses a relay-mesh agent before touching anything", () => {
    const minted = mintAgent({ provider: " relay-mesh " });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/loopback proxy/);
  });

  it("refuses a relay url that is not a websocket url", () => {
    const minted = mintAgent({ relay_url: "https://relay.example" });
    expect(() => parseDeployPayload(minted.agent)).toThrow(/ws:\/\/ or wss:\/\//);
  });

  it("reads every field of the desktop's own golden payload", () => {
    // Copied verbatim from the Buzz repo's provider-wire tests, so a change to
    // the desktop's payload shape shows up here as a failure rather than as a
    // mystery at deploy time.
    const fixture = JSON.parse(
      readFileSync("test/fixtures/buzz-deploy-full-launch.request.json", "utf8"),
    ) as { agent: Record<string, unknown> };

    // The fixture's `auth_tag` is the opaque placeholder `"tag-1"` — the
    // Kubernetes binding forwards it without looking. We verify it, so first
    // pin that a placeholder is refused…
    expect(() => parseDeployPayload(fixture.agent)).toThrow(/not valid JSON|malformed/);

    // …then mint a real attestation for the fixture's own key and assert the
    // rest of the desktop's payload parses exactly as sent.
    const secret = decodeSecretKey(fixture.agent["private_key_nsec"] as string);
    const agentPubkey = createSigner(Uint8Array.from(secret)).publicKey;
    const ownerSecret = generateSecretKey();
    const auth = signAttestation(ownerSecret, agentPubkey, "");
    const ownerPubkey = createSigner(Uint8Array.from(ownerSecret)).publicKey;

    const launch = fixture.agent["launch"] as Record<string, unknown>;
    launch["owner_pubkey"] = ownerPubkey;
    fixture.agent["auth_tag"] = JSON.stringify(toNostrTag(auth));

    const payload = parseDeployPayload(fixture.agent);
    expect(payload.agentPubkey).toBe(agentPubkey);
    expect(payload.name).toBe("worker");
    expect(payload.relayUrl).toBe("wss://relay.example");
    expect(payload.respondTo).toBe("allowlist");
    expect(payload.respondToAllowlist).toHaveLength(2);
    expect(payload.model).toBe("gpt-5");
    expect(payload.launch?.env).toMatchObject({ USER_KEY: "user-value" });
    expect(payload.launch?.policyEnv).toMatchObject({ BUZZ_ACP_AGENTS: "10" });
  });
});
