import { describe, expect, it } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { createSigner, type Signer } from "../src/nostr/signer.js";
import {
  AUTH_SLUG,
  CONFIG_SLUG,
  deriveRecordDTag,
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
    ["autogent/config", "b5f40773da179a3d774c32139587867cea1d541be69f053a0f96234b85f9e0ba"],
    ["autogent/auth", "38abf98999edc41e152f187416227cc70d57418da9007fc737e8939b94dd8963"],
    ["autogent/example", "abf08681ae786cfa37a7a32f3246b9ae15f2f6596e7d0d58de0d0178d38df72d"],
    ["autogent/notes/2026-05-12", "e1316c60b845c464202a9e04957c1aff587a3903ae7cdc6ca78c67b848843f17"],
  ])("derives the pinned vector for %s", (slug, expected) => {
    expect(deriveRecordDTag(agentSigner(), slug)).toBe(expected);
  });

  it("is keyed by the agent secret: another key derives different tags", () => {
    const other = createSigner(new Uint8Array(SK_OTHER));
    expect(deriveRecordDTag(other, CONFIG_SLUG)).not.toBe(deriveRecordDTag(agentSigner(), CONFIG_SLUG));
  });

  it("refuses an invalid slug", () => {
    expect(() => deriveRecordDTag(agentSigner(), "not-a-slug")).toThrow(/invalid/);
  });
});

describe("slug grammar", () => {
  it.each([
    "autogent/config",
    "autogent/auth",
    "autogent/a",
    "autogent/notes/2026-05-12",
    "autogent/a_b-c/d0",
  ])("accepts %s", (slug) => expect(isValidSlug(slug)).toBe(true));

  it.each([
    "",
    "Core",
    "autogent",
    "autogent/",
    "autogent//x",
    "autogent/UPPER",
    "autogent/-lead",
    "other/x",
    "core",
    "mem/a",
    "mem/provider-auth",
  ])("rejects %s", (slug) => expect(isValidSlug(slug)).toBe(false));

  it("rejects slugs over 255 bytes", () => {
    expect(
      isValidSlug(`autogent/${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(64)}`),
    ).toBe(false);
  });
});

describe("record bodies", () => {
  it("round-trips a config body with the document as-is in `value`", () => {
    const document = { v: 1, model: "anthropic/claude-sonnet-4-5" };
    const body = parseRecordBody(JSON.stringify({ slug: CONFIG_SLUG, value: document }), CONFIG_SLUG);
    expect(body).toEqual({ slug: CONFIG_SLUG, value: document });
  });

  it("round-trips an auth body and recognises tombstones", () => {
    const live = parseRecordBody(
      JSON.stringify({ slug: AUTH_SLUG, value: { anthropic: { type: "oauth" } } }),
      AUTH_SLUG,
    );
    expect(live).toEqual({ slug: AUTH_SLUG, value: { anthropic: { type: "oauth" } } });

    const tomb = parseRecordBody(JSON.stringify({ slug: AUTH_SLUG, value: null }), AUTH_SLUG);
    expect(tomb).not.toBeNull();
    expect(
      isTombstone({ event: {} as NostrEvent, body: tomb as NonNullable<typeof tomb>, createdAt: 1 }),
    ).toBe(true);
  });

  it("rejects a body whose slug does not match the queried slug", () => {
    expect(parseRecordBody(JSON.stringify({ slug: "autogent/other", value: {} }), AUTH_SLUG)).toBeNull();
    expect(parseRecordBody(JSON.stringify({ slug: AUTH_SLUG, value: {} }), CONFIG_SLUG)).toBeNull();
  });

  it("requires `value` to be a JSON object (or a null tombstone)", () => {
    expect(parseRecordBody(JSON.stringify({ slug: CONFIG_SLUG, value: "{}" }), CONFIG_SLUG)).toBeNull();
    expect(parseRecordBody(JSON.stringify({ slug: CONFIG_SLUG, value: [1] }), CONFIG_SLUG)).toBeNull();
    expect(parseRecordBody(JSON.stringify({ slug: AUTH_SLUG, value: "{}" }), AUTH_SLUG)).toBeNull();
    // The config document cannot be tombstoned.
    expect(parseRecordBody(JSON.stringify({ slug: CONFIG_SLUG, value: null }), CONFIG_SLUG)).toBeNull();
  });

  it("rejects malformed JSON and non-object payloads", () => {
    expect(parseRecordBody("nope", CONFIG_SLUG)).toBeNull();
    expect(parseRecordBody('"str"', CONFIG_SLUG)).toBeNull();
  });

  it("caps the serialised body at the NIP-44 plaintext limit", () => {
    expect(() =>
      serializeRecordBody({ slug: CONFIG_SLUG, value: { pad: "x".repeat(70_000) } }),
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
    slug: CONFIG_SLUG,
  });

  it("selects the newest valid head", () => {
    const signer = agentSigner();
    const older = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1, tag: "old" } }, 100);
    const newer = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1, tag: "new" } }, 200);
    const head = selectRecordHead([older, newer], context());
    expect(head?.createdAt).toBe(200);
    expect(head?.body.value).toEqual({ v: 1, tag: "new" });
  });

  it("breaks created_at ties by lowest event id", () => {
    const signer = agentSigner();
    const a = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1, tag: "a" } }, 100);
    const b = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1, tag: "b" } }, 100);
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const head = selectRecordHead([high, low], context());
    expect(head?.event.id).toBe(low.id);
  });

  it("skips events with a broken signature rather than failing the selection", () => {
    const signer = agentSigner();
    const good = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1, tag: "good" } }, 100);
    // JSON round-trip strips nostr-tools' memoised verification symbol, which
    // a plain object spread would smuggle along with the forged signature.
    const forged = {
      ...(JSON.parse(
        JSON.stringify(
          recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1, tag: "bad" } }, 200),
        ),
      ) as NostrEvent),
      sig: "0".repeat(128),
    };
    const head = selectRecordHead([forged, good], context());
    expect(head?.body.value).toEqual({ v: 1, tag: "good" });
  });

  it("skips events from the wrong author or with the wrong tags", () => {
    const signer = agentSigner();
    const wrongAuthor = {
      ...recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1 } }, 100),
      pubkey: getPublicKey(SK_OTHER),
    };
    const wrongD = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1 } }, 100, {
      tags: [["d", "00".repeat(32)]],
    });
    expect(selectRecordHead([wrongAuthor, wrongD], context())).toBeNull();
  });

  it("skips events of a foreign kind under the same d-tag", () => {
    const signer = agentSigner();
    const wrongKind = recordEvent(signer, CONFIG_SLUG, { slug: CONFIG_SLUG, value: { v: 1 } }, 100, {
      kind: 30174,
    });
    expect(selectRecordHead([wrongKind], context())).toBeNull();
  });

  it("skips a body that does not re-derive to the queried slug", () => {
    const signer = agentSigner();
    const mismatched = recordEvent(signer, CONFIG_SLUG, { slug: "autogent/other", value: {} }, 100);
    expect(selectRecordHead([mismatched], context())).toBeNull();
  });

  it("skips content encrypted to a counterparty instead of self", () => {
    const signer = agentSigner();
    const other = createSigner(new Uint8Array(SK_OTHER));
    const foreign = finalizeEvent(
      {
        kind: KIND.APP_DATA,
        created_at: 100,
        tags: [["d", deriveRecordDTag(signer, CONFIG_SLUG)]],
        content: signer.encrypt(other.publicKey, JSON.stringify({ slug: CONFIG_SLUG, value: { v: 1 } })),
      },
      new Uint8Array(SK_AGENT),
    ) as NostrEvent;
    expect(selectRecordHead([foreign], context())).toBeNull();
  });
});
