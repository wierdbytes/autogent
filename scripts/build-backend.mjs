#!/usr/bin/env node
/**
 * Bundles `buzz-backend-autogent` into a single self-contained file.
 *
 * This is not a packaging preference — it is forced by the protocol. Before
 * sending an nsec, Buzz Desktop **copies the resolved provider binary into a
 * temporary directory** and runs both `info` and `deploy` from that copy, so
 * that the bytes which answered the version negotiation are the exact bytes
 * that receive the secret. A multi-file build cannot survive that: from
 * `/tmp/…/provider`, neither `./wire.js` nor a bare `nostr-tools` specifier
 * resolves to anything.
 *
 * CommonJS, deliberately. The staged copy has no file extension and no
 * `package.json` beside it, so Node treats it as CommonJS by default. An ESM
 * bundle would depend on Node's module-syntax detection to rescue it; a CJS
 * bundle simply parses.
 */

import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/**
 * Last-resort location of the agent binary, baked at build time.
 *
 * Used only when `autogent-nostr` cannot be found on the augmented PATH, and
 * only when it still exists on disk — so it is a no-op for anyone who installed
 * the package somewhere else.
 */
const agentFallback = join(root, "dist", "cli.js");

/** Single-quotes a value for `sh`. */
function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Candidate `node` interpreters, searched in order.
 *
 * The first is the interpreter that ran this build — a strong hint on a
 * developer machine and harmless anywhere else. The rest cover the version
 * managers and package managers that actually put `node` outside the system
 * PATH. Unmatched globs stay literal and simply fail the `-x` test.
 */
const nodeCandidates = [
  shQuote(process.execPath),
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  '"$HOME/.local/bin/node"',
  '"$HOME/.volta/bin/node"',
  '"$HOME/.fnm/aliases/default/bin/node"',
  '"$HOME/Library/Application Support/fnm/aliases/default/bin/node"',
  "$HOME/.nvm/versions/node/*/bin/node",
  "$HOME/.asdf/installs/nodejs/*/bin/node",
  "/usr/bin/node",
].join(" ");

/**
 * A `/bin/sh` script that is also a valid JavaScript program.
 *
 * `#!/usr/bin/env node` cannot be used here, and its failure is total rather
 * than degraded: Buzz Desktop launched from Finder inherits launchd's minimal
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which contains no `node` for anyone
 * using Homebrew, nvm, fnm, volta or asdf. `env` then exits 127 before a single
 * byte of this program runs — so there is no in-band error to report, and the
 * desktop can only surface `exit code 127`.
 *
 * So `/bin/sh` — which is always present — finds the interpreter instead, and
 * `exec`s it on this same file. Each line works twice: `sh` reads `':'` as the
 * null command and runs the rest, while JavaScript reads `':'` as a string
 * expression and `//` as a comment. Node strips the `#!` line itself.
 *
 * When no interpreter is found we exit **127 with an explanation on stderr**,
 * because the alternative — an empty `exec` — reproduces the bare status code
 * this header exists to eliminate.
 */
const banner = [
  "#!/bin/sh",
  `':' //; N=$(command -v node 2>/dev/null); [ -n "$N" ] || for c in ${nodeCandidates}; do [ -x "$c" ] && N=$c && break; done`,
  `':' //; [ -n "$N" ] || { echo "buzz-backend-autogent: no 'node' interpreter found (searched PATH and the usual install locations). Install Node >= 22.19, or symlink your node into ~/.local/bin." >&2; exit 127; }`,
  `':' //; exec "$N" "$0" "$@"`,
].join("\n");

/** Both providers share the wire layer and the self-contained-bundle rule. */
const providers = [
  { entry: join(root, "src", "backend", "cli.ts"), out: "buzz-backend-autogent.cjs" },
  { entry: join(root, "src", "backend-k8s", "cli.ts"), out: "buzz-backend-autogent-k8s.cjs" },
];

for (const provider of providers) {
  const outfile = join(root, "dist", "backend", provider.out);
  await build({
    entryPoints: [provider.entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    banner: { js: banner },
    define: {
      __AUTOGENT_VERSION__: JSON.stringify(pkg.version),
      __AUTOGENT_AGENT_FALLBACK__: JSON.stringify(agentFallback),
    },
  });
  // esbuild writes with the default 0644 (or preserves a stale mode when
  // overwriting); the `bin` entries and `backend:install` symlinks need the
  // bundle itself to be executable, so set it explicitly every build.
  chmodSync(outfile, 0o755);
  process.stdout.write(`built dist/backend/${provider.out}\n`);
}

// tsc emits the interactive CLI without the exec bit; the `autogent` bin and
// the backend:install symlink both need it.
chmodSync(join(root, "dist", "interactive", "cli.js"), 0o755);
