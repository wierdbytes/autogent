import { describe, expect, it } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import {
  CORE_SLUG,
  PROVIDER_AUTH_SLUG,
  deriveEngramDTag,
  isCoreBody,
  isTombstone,
  isValidSlug,
  parseEngramBody,
  selectEngramHead,
  serializeEngramBody,
} from "../src/nostr/nip-ae.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { finalizeEvent } from "nostr-tools/pure";

/** NIP-AE test keys (spec §Test Vectors — never production keys). */
const SK_AGENT = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
const SK_OWNER = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");
const PK_AGENT = getPublicKey(SK_AGENT);
const PK_OWNER = getPublicKey(SK_OWNER);

function agentSigner(): Signer {
  return createSigner(new Uint8Array(SK_AGENT));
}

describe("NIP-AE d-tag derivation", () => {
  // Vectors straight from the NIP-AE spec; they pin the domain separator, the
  // null byte and the conversation-key derivation all at once.
  it.each([
    ["core", "bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90"],
    ["mem/example", "72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba"],
    ["mem/notes/2026-05-12", "31651571a312780cfdc1f0b706b682ac9f3f51a053e8dca76fe57710bae5a4d4"],
  ])("derives the spec vector for %s", (slug, expected) => {
    expect(deriveEngramDTag(agentSigner(), PK_OWNER, slug)).toBe(expected);
  });

  it("is symmetric: the owner derives the same tag toward the agent", () => {
    const owner = createSigner(new Uint8Array(SK_OWNER));
    expect(deriveEngramDTag(owner, PK_AGENT, "core")).toBe(
      deriveEngramDTag(agentSigner(), PK_OWNER, "core"),
    );
  });

  it("refuses an invalid slug", () => {
    expect(() => deriveEngramDTag(agentSigner(), PK_OWNER, "not-a-slug")).toThrow(/invalid/);
  });
});

describe("slug grammar", () => {
  it.each(["core", "mem/a", "mem/provider-auth", "mem/notes/2026-05-12", "mem/a_b-c/d0"])(
    "accepts %s",
    (slug) => expect(isValidSlug(slug)).toBe(true),
  );

  it.each(["", "Core", "mem", "mem/", "mem//x", "mem/UPPER", "mem/-lead", "other/x", "core/x"])(
    "rejects %s",
    (slug) => expect(isValidSlug(slug)).toBe(false),
  );

  it("rejects slugs over 255 bytes", () => {
    expect(isValidSlug(`mem/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(64)}`)).toBe(
      false,
    );
  });
});

describe("engram bodies", () => {
  it("round-trips a core body", () => {
    const body = parseEngramBody(JSON.stringify({ slug: "core", profile: "{}" }), CORE_SLUG);
    expect(body).toEqual({ slug: "core", profile: "{}" });
    expect(body && isCoreBody(body)).toBe(true);
  });

  it("round-trips a memory body and recognises tombstones", () => {
    const live = parseEngramBody(
      JSON.stringify({ slug: PROVIDER_AUTH_SLUG, value: "{}" }),
      PROVIDER_AUTH_SLUG,
    );
    expect(live).toEqual({ slug: PROVIDER_AUTH_SLUG, value: "{}" });

    const tomb = parseEngramBody(
      JSON.stringify({ slug: PROVIDER_AUTH_SLUG, value: null }),
      PROVIDER_AUTH_SLUG,
    );
    expect(tomb).not.toBeNull();
    expect(
      isTombstone({ event: {} as NostrEvent, body: tomb as NonNullable<typeof tomb>, createdAt: 1 }),
    ).toBe(true);
  });

  it("rejects a body whose slug does not match the queried slug", () => {
    expect(parseEngramBody(JSON.stringify({ slug: "mem/other", value: "x" }), PROVIDER_AUTH_SLUG)).toBeNull();
    expect(parseEngramBody(JSON.stringify({ slug: "core", value: "x" }), CORE_SLUG)).toBeNull();
  });

  it("rejects malformed JSON and non-object payloads", () => {
    expect(parseEngramBody("nope", CORE_SLUG)).toBeNull();
    expect(parseEngramBody('"str"', CORE_SLUG)).toBeNull();
  });

  it("caps the serialised body at the NIP-44 plaintext limit", () => {
    expect(() =>
      serializeEngramBody({ slug: PROVIDER_AUTH_SLUG, value: "x".repeat(70_000) }),
    ).toThrow(/65535/);
  });
});

function engramEvent(
  signer: Signer,
  slug: string,
  body: unknown,
  createdAt: number,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  const event = finalizeEvent(
    {
      kind: KIND.ENGRAM,
      created_at: createdAt,
      tags: [
        ["d", deriveEngramDTag(signer, PK_OWNER, slug)],
        ["p", PK_OWNER],
      ],
      content: signer.encrypt(PK_OWNER, JSON.stringify(body)),
    },
    new Uint8Array(SK_AGENT),
  ) as NostrEvent;
  return { ...event, ...overrides };
}

describe("head selection", () => {
  const context = () => ({
    signer: agentSigner(),
    agentPubkey: PK_AGENT,
    ownerPubkey: PK_OWNER,
    slug: CORE_SLUG,
  });

  it("selects the newest valid head", () => {
    const signer = agentSigner();
    const older = engramEvent(signer, "core", { slug: "core", profile: "old" }, 100);
    const newer = engramEvent(signer, "core", { slug: "core", profile: "new" }, 200);
    const head = selectEngramHead([older, newer], context());
    expect(head?.createdAt).toBe(200);
    expect(head && isCoreBody(head.body) && head.body.profile).toBe("new");
  });

  it("breaks created_at ties by lowest event id", () => {
    const signer = agentSigner();
    const a = engramEvent(signer, "core", { slug: "core", profile: "a" }, 100);
    const b = engramEvent(signer, "core", { slug: "core", profile: "b" }, 100);
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const head = selectEngramHead([high, low], context());
    expect(head?.event.id).toBe(low.id);
  });

  it("skips events with a broken signature rather than failing the selection", () => {
    const signer = agentSigner();
    const good = engramEvent(signer, "core", { slug: "core", profile: "good" }, 100);
    // JSON round-trip strips nostr-tools' memoised verification symbol, which
    // a plain object spread would smuggle along with the forged signature.
    const forged = {
      ...(JSON.parse(
        JSON.stringify(engramEvent(signer, "core", { slug: "core", profile: "bad" }, 200)),
      ) as NostrEvent),
      sig: "0".repeat(128),
    };
    const head = selectEngramHead([forged, good], context());
    expect(head && isCoreBody(head.body) && head.body.profile).toBe("good");
  });

  it("skips events from the wrong author or with the wrong tags", () => {
    const signer = agentSigner();
    const wrongAuthor = {
      ...engramEvent(signer, "core", { slug: "core", profile: "x" }, 100),
      pubkey: PK_OWNER,
    };
    const wrongD = engramEvent(signer, "core", { slug: "core", profile: "x" }, 100, {
      tags: [
        ["d", "00".repeat(32)],
        ["p", PK_OWNER],
      ],
    });
    expect(selectEngramHead([wrongAuthor, wrongD], context())).toBeNull();
  });

  it("skips a body that does not re-derive to the queried slug", () => {
    const signer = agentSigner();
    const mismatched = engramEvent(signer, "core", { slug: "mem/other", value: "x" }, 100);
    expect(selectEngramHead([mismatched], context())).toBeNull();
  });
});
