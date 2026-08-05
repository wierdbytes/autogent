import { describe, expect, it } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import {
  CORE_SLUG,
  PROVIDER_AUTH_SLUG,
  deriveRecordDTag,
  isCoreBody,
  isTombstone,
  isValidSlug,
  parseRecordBody,
  selectRecordHead,
  serializeRecordBody,
} from "../src/nostr/config-records.js";
import { KIND, type NostrEvent } from "../src/nostr/types.js";
import { finalizeEvent } from "nostr-tools/pure";

/** Well-known test keys (sec = 0x…01 / 0x…02 — never production keys). */
const SK_AGENT = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
const SK_OTHER = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");
const PK_AGENT = getPublicKey(SK_AGENT);

function agentSigner(): Signer {
  return createSigner(new Uint8Array(SK_AGENT));
}

describe("config-record d-tag derivation", () => {
  // Pinned vectors: HMAC-SHA256 over the agent's NIP-44 *self* conversation
  // key with domain "agent-config/v1/d-tag" || 0x00 || slug. They pin the
  // domain separator, the null byte and the self-key derivation all at once —
  // any accidental change to one of them fails these.
  it.each([
    ["core", "2fcaaf5464f5e3fd6ea6bb2b0c2ed9454d9dc6fc08ecf292a6c91f6087d83394"],
    ["mem/example", "ba7e38cdb8b07dd9fa92f767b0890c483fcbef9709d542f1f5d9d864e061028f"],
    ["mem/notes/2026-05-12", "a2227ce9c25e5d566e273df48a1e0812adad492af5b259882f0c3e6a19ec869f"],
    ["mem/provider-auth", "47342ade9493868722a5a6ac83bc4c5d7a74b29b139f63222b979765c2d7fc52"],
  ])("derives the pinned vector for %s", (slug, expected) => {
    expect(deriveRecordDTag(agentSigner(), slug)).toBe(expected);
  });

  it("is keyed by the agent secret: another key derives different tags", () => {
    const other = createSigner(new Uint8Array(SK_OTHER));
    expect(deriveRecordDTag(other, "core")).not.toBe(deriveRecordDTag(agentSigner(), "core"));
  });

  it("refuses an invalid slug", () => {
    expect(() => deriveRecordDTag(agentSigner(), "not-a-slug")).toThrow(/invalid/);
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

describe("record bodies", () => {
  it("round-trips a core body", () => {
    const body = parseRecordBody(JSON.stringify({ slug: "core", profile: "{}" }), CORE_SLUG);
    expect(body).toEqual({ slug: "core", profile: "{}" });
    expect(body && isCoreBody(body)).toBe(true);
  });

  it("round-trips a memory body and recognises tombstones", () => {
    const live = parseRecordBody(
      JSON.stringify({ slug: PROVIDER_AUTH_SLUG, value: "{}" }),
      PROVIDER_AUTH_SLUG,
    );
    expect(live).toEqual({ slug: PROVIDER_AUTH_SLUG, value: "{}" });

    const tomb = parseRecordBody(
      JSON.stringify({ slug: PROVIDER_AUTH_SLUG, value: null }),
      PROVIDER_AUTH_SLUG,
    );
    expect(tomb).not.toBeNull();
    expect(
      isTombstone({ event: {} as NostrEvent, body: tomb as NonNullable<typeof tomb>, createdAt: 1 }),
    ).toBe(true);
  });

  it("rejects a body whose slug does not match the queried slug", () => {
    expect(parseRecordBody(JSON.stringify({ slug: "mem/other", value: "x" }), PROVIDER_AUTH_SLUG)).toBeNull();
    expect(parseRecordBody(JSON.stringify({ slug: "core", value: "x" }), CORE_SLUG)).toBeNull();
  });

  it("rejects malformed JSON and non-object payloads", () => {
    expect(parseRecordBody("nope", CORE_SLUG)).toBeNull();
    expect(parseRecordBody('"str"', CORE_SLUG)).toBeNull();
  });

  it("caps the serialised body at the NIP-44 plaintext limit", () => {
    expect(() =>
      serializeRecordBody({ slug: PROVIDER_AUTH_SLUG, value: "x".repeat(70_000) }),
    ).toThrow(/65535/);
  });
});

function recordEvent(
  signer: Signer,
  slug: string,
  body: unknown,
  createdAt: number,
  overrides: Partial<NostrEvent> = {},
): NostrEvent {
  const event = finalizeEvent(
    {
      kind: KIND.APP_DATA,
      created_at: createdAt,
      tags: [["d", deriveRecordDTag(signer, slug)]],
      content: signer.encrypt(signer.publicKey, JSON.stringify(body)),
    },
    new Uint8Array(SK_AGENT),
  ) as NostrEvent;
  return { ...event, ...overrides };
}

describe("head selection", () => {
  const context = () => ({
    signer: agentSigner(),
    agentPubkey: PK_AGENT,
    slug: CORE_SLUG,
  });

  it("selects the newest valid head", () => {
    const signer = agentSigner();
    const older = recordEvent(signer, "core", { slug: "core", profile: "old" }, 100);
    const newer = recordEvent(signer, "core", { slug: "core", profile: "new" }, 200);
    const head = selectRecordHead([older, newer], context());
    expect(head?.createdAt).toBe(200);
    expect(head && isCoreBody(head.body) && head.body.profile).toBe("new");
  });

  it("breaks created_at ties by lowest event id", () => {
    const signer = agentSigner();
    const a = recordEvent(signer, "core", { slug: "core", profile: "a" }, 100);
    const b = recordEvent(signer, "core", { slug: "core", profile: "b" }, 100);
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const head = selectRecordHead([high, low], context());
    expect(head?.event.id).toBe(low.id);
  });

  it("skips events with a broken signature rather than failing the selection", () => {
    const signer = agentSigner();
    const good = recordEvent(signer, "core", { slug: "core", profile: "good" }, 100);
    // JSON round-trip strips nostr-tools' memoised verification symbol, which
    // a plain object spread would smuggle along with the forged signature.
    const forged = {
      ...(JSON.parse(
        JSON.stringify(recordEvent(signer, "core", { slug: "core", profile: "bad" }, 200)),
      ) as NostrEvent),
      sig: "0".repeat(128),
    };
    const head = selectRecordHead([forged, good], context());
    expect(head && isCoreBody(head.body) && head.body.profile).toBe("good");
  });

  it("skips events from the wrong author or with the wrong tags", () => {
    const signer = agentSigner();
    const wrongAuthor = {
      ...recordEvent(signer, "core", { slug: "core", profile: "x" }, 100),
      pubkey: getPublicKey(SK_OTHER),
    };
    const wrongD = recordEvent(signer, "core", { slug: "core", profile: "x" }, 100, {
      tags: [["d", "00".repeat(32)]],
    });
    expect(selectRecordHead([wrongAuthor, wrongD], context())).toBeNull();
  });

  it("skips events of a foreign kind under the same d-tag", () => {
    const signer = agentSigner();
    const wrongKind = recordEvent(signer, "core", { slug: "core", profile: "x" }, 100, {
      kind: 30174,
    });
    expect(selectRecordHead([wrongKind], context())).toBeNull();
  });

  it("skips a body that does not re-derive to the queried slug", () => {
    const signer = agentSigner();
    const mismatched = recordEvent(signer, "core", { slug: "mem/other", value: "x" }, 100);
    expect(selectRecordHead([mismatched], context())).toBeNull();
  });

  it("skips content encrypted to a counterparty instead of self", () => {
    const signer = agentSigner();
    const other = createSigner(new Uint8Array(SK_OTHER));
    const foreign = finalizeEvent(
      {
        kind: KIND.APP_DATA,
        created_at: 100,
        tags: [["d", deriveRecordDTag(signer, "core")]],
        content: signer.encrypt(other.publicKey, JSON.stringify({ slug: "core", profile: "x" })),
      },
      new Uint8Array(SK_AGENT),
    ) as NostrEvent;
    expect(selectRecordHead([foreign], context())).toBeNull();
  });
});
