# `buzz-backend-autogent` — the local-process binding

A conforming Buzz Desktop backend provider that deploys `autogent-nostr` as a
detached process on the machine running the desktop.

It implements the contract in
[`buzz/docs/remote-agents.md`](https://github.com/block/buzz/blob/main/docs/remote-agents.md).
That document defines three nested contracts — the **agent/harness contract**
that binds every launcher, the **provider/deployer contract** that binds
provider-managed launches, and a **binding policy** each substrate writes for
itself. This file is the third one. Where the Kubernetes binding says "pod",
this one says "process"; where it says "Secret", this one says "sealed state
directory". The properties are the same, and the places they are *not* are
stated rather than skipped.

## What it is

```
Buzz Desktop ──stdin/stdout JSON──→ buzz-backend-autogent ──spawn──→ autogent-nostr
                                                                          │
Buzz Desktop ←──────────────── relay (presence, !shutdown) ───────────────┘
```

Two operations, one process each: `info` and `deploy`. After a deploy the
desktop holds **no management channel** to the agent — status is relay presence,
stop is a relay message. That is the spec's design axiom, and it is why this
provider has no `status` or `stop` operation to offer.

## Substrate mapping

| Kubernetes binding | this binding |
|---|---|
| namespace (deployment scope) | `state_root` directory (default `~/.buzz-autogent`) |
| Pod, deterministically named `buzz-agent-<first-12-hex>` | instance directory `instances/<first-12-hex>` + its `instance.json` |
| identity label + full-pubkey annotation | directory name + `agent_pubkey` (full 64 hex) in the record |
| `app.kubernetes.io/managed-by` label (management marker) | `managed_by: buzz-backend-autogent` + `binding_version` |
| `buzz.block.xyz/create-intent` annotation | `create_intent` (SHA-256 over the same class of inputs) |
| per-attempt Secret `…-<gen>` holding the identity | per-agent sealed state directory + per-attempt `generation` token |
| container `state.running` = started | the agent's own `"agent online"` log line |
| `resourceVersion`-unset quorum read | a fresh `readFileSync` + `ps` probe |
| UID + `resourceVersion` delete precondition | re-read of the online marker and the generation immediately before the signal |
| `Status.reason` 409 discriminator | `EEXIST` from an exclusive (`wx`) create |
| `terminationGracePeriodSeconds: 60` | 60s between SIGTERM and SIGKILL |
| `restartPolicy: Never` | no supervisor at all |
| Completed pod kept for forensics until next deploy | `agent.log` rotated to `agent.prev.log` on the next create |

### On-disk layout

```
<state_root>/instances/<first-12-hex-of-pubkey>/
    instance.json     the record: identity, marker, generation, intent, pid
    state/            AUTOGENT_STATE_DIR — sealed key (0600), identity, database
    workspace/        the agent's cwd, unless `workspace` is configured
    agent.log         this generation's output
    agent.prev.log    the previous generation's, kept for one deploy
```

## The invariants, on this substrate

**I1 — identity fail-closed.** An empty or undecodable `private_key_nsec` is
refused before anything is created (`payload.ts`). So is a missing or
unverifiable owner attestation: `autogent-nostr` signs every event with the
owner's NIP-OA `auth` tag, so unlike the `buzz-acp` harness it cannot fall back
to a bare `owner_pubkey`, and a legacy record without an `auth_tag` is refused
with a message that says so. The attestation is verified against the pubkey
**derived from the nsec**, so a payload cannot hand over an attestation minted
for a different key.

**I2 — no secrets in configuration.** The five config fields are `command`,
`state_root`, `workspace`, `startup_timeout_seconds`, `log_level`. None of them
can hold a credential, and a test reproduces the desktop's anti-secret key-name
lint and runs it against the schema, so a future field cannot be named into a
deploy-time rejection.

**I3 — presence is the status.** The agent publishes kind 20001 as it always
does. Two knobs that would silently un-make that promise are refused in user
env: `BUZZ_ACP_NO_PRESENCE` and a falsy `AUTOGENT_PRESENCE`. The staleness bound
is the relay's, unchanged; the *avoidable* half is minimised by giving the agent
60 seconds of graceful shutdown before SIGKILL, which is enough for it to drain,
publish presence `offline` and close the relay connection.

**I4 — at most one live instance per key per scope.** The instance record is
created with an exclusive (`wx`) write, so the filesystem elects the winner of a
race and the loser re-classifies and adopts it rather than failing. A started
instance is a **strict no-op** with zero mutation: no rewritten record, no
re-sealed key. The scope is one `state_root`; as upstream, deploying the same
key into two scopes is user error with confusing-but-safe results, not a safety
violation.

**I5 — intentional termination is final.** Owner `!shutdown` reaches the agent
over the relay, is verified against the owner pubkey, and runs the graceful
shutdown path. SIGTERM lands on the agent process itself — there is no shell, no
`npm run`, no wrapper to swallow it. Nothing restarts the process, so "a clean
exit is never resurrected" holds vacuously, which is the honest form of this
invariant for a substrate with no supervision.

**Lifetime policy: indefinite, deliberately.** The spec blesses "no inactivity
bound" as an explicit owner choice, and that is what this binding ships:
`autogent-nostr` has no `--exit-after-inactivity` equivalent, so rather than
advertise an `inactivity_seconds` field that would do nothing, the field is
absent. The trade is honest for the substrate — an idle process on your own
laptop is not metered compute with nobody watching it — but it is a real gap
against the Kubernetes binding's default, and closing it means adding a
pool-independent reaper timer to the agent first.

## Deviations, stated

1. **The harness is `autogent-nostr`, not `buzz-acp`.** This provider is
   single-purpose: it deploys one agent, in-process on the Pi SDK. A desktop
   record configured for `goose` or `claude-agent-acp` still gets
   `autogent-nostr`. The requested command is written into `instance.json` as
   `requested_command` so the substitution is visible on disk rather than
   invisible everywhere. `launch.command`/`launch.args` are therefore recorded,
   not executed.

2. **Identity is delivered on disk, not in the environment.** The Kubernetes
   binding passes the nsec through `envFrom` a Secret. A local process's
   environment is readable by anything running as the same user and shows up in
   crash dumps, so the key is written where `autogent-nostr` already keeps it: a
   0700 directory with a 0600 key file, through the same `IdentityStore` the
   `init` / `provision import` commands use. `BUZZ_PRIVATE_KEY`,
   `NOSTR_PRIVATE_KEY` and `BUZZ_AUTH_TAG` never appear in the child's
   environment at all.

   *Residual exposure, stated:* any process running as this user can read the
   key file, and a host backup that copies the state directory copies the key.
   The isolation unit is the user account — the analogue of the pod binding's
   "the namespace is the isolation unit".

3. **`launch.policy_env` is translated, not just forwarded.** Its `BUZZ_ACP_*`
   names address a harness that is not running here. The four with exact
   counterparts (`MODEL`, `IDLE_TIMEOUT`, `MAX_TURN_DURATION`, `AGENTS`) become
   `AUTOGENT_*` at **tier 1**, keeping their overridable status — locally the
   desktop writes them before the user env layer, and a provider that mapped
   them afterwards would silently defeat an override that works locally.
   `BUZZ_ACP_TEAM_INSTRUCTIONS` is concatenated onto the system prompt, because
   it is the one policy value no substrate can reconstruct and the agent has a
   single appended-prompt knob. The originals are still passed through.

4. **The ambient `AUTOGENT_*` and `BUZZ_*` environment is stripped.** The child
   inherits the desktop's environment — that is how the Pi provider credential,
   `HOME` and the user's toolchain reach it, exactly as for a local spawn — but
   this machine's *own* agent configuration is removed first. Launch data has to
   be a function of the record and the config alone, or a developer's shell
   would silently reconfigure every agent deployed from their laptop.

## Conformance notes

**Exit codes carry one bit.** Every handled failure is in-band
`{"ok": false, "error": …}` with **status 0**, because a non-zero status makes
the desktop discard stdout and the explanation with it. The only non-zero exit
is an unreadable stdin, where no response can be composed.

**The `info` response is a closed set.** The desktop validates it against an
allowlist of exactly `ok`, `name`, `version`, `protocol_version`, `description`,
`config_schema`. A test pins the key set, because adding a helpful field here
breaks every deploy at a place that looks unrelated.

**Startup is part of create.** `deploy` returns an `agent_id` only once the
agent has logged `"agent online"` — after it connected, authenticated, published
its profile and subscribed. A successful `spawn` proves only that the kernel
accepted an image.

**A deadline never destroys anything.** `startup_timeout_seconds` bounds how
long one Start waits, nothing more. A still-starting instance is observed and
left alone, on that call and every later one; the next Start adopts whatever it
became. What replaces a never-started instance is a **change of intent** — the
user editing the configuration it is wedged on — which is the only escape from a
wedge and is not clocked to anything.

**Destructive steps are fenced.** Nothing is deleted unless the record carries
the management marker and the full agent pubkey. Immediately before signalling a
process, the online marker and the generation are re-read: an agent that finished
starting up in the microseconds since classification is left alone. Terminated
residue is cleared, but the state directory — sealed identity, dedup ledger,
signed outbox — always survives, because that is what makes a restart re-send
identical bytes instead of producing a second message.

**Self-contained by necessity.** Before sending the nsec, the desktop copies the
provider into a temp directory and runs both `info` and `deploy` from the copy,
so the bytes that answered the version negotiation are the bytes that receive the
secret. For a Node provider that forces a single-file CommonJS bundle: from
`/tmp/…/provider`, neither a relative import nor a bare package specifier
resolves. `test/backend-staging.test.ts` builds the artifact and runs it exactly
that way.

**The interpreter is found by the artifact, not by `env`.** The bundle's header
is a `/bin/sh` script that is also valid JavaScript: `sh` locates a `node` and
`exec`s it on the same file, while Node reads each header line as a string
expression followed by a comment.

The reason is a failure mode with no in-band form. A Finder-launched desktop
inherits launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — which contains no
`node` for anyone using Homebrew, nvm, fnm, volta or asdf. With
`#!/usr/bin/env node`, `env` exits **127 before a byte of the provider runs**:
there is no process to compose `{"ok": false, "error": …}`, so the protocol's
entire error channel is unavailable and the UI can only report a status code.
The spec's advice for this class — *providers whose credentials invoke helper
binaries MUST self-augment their PATH rather than assume a login shell* — applies
one step earlier here: the provider has to be able to start at all before it can
augment anything.

When no interpreter is found anywhere the header exits 127 **with an explanation
on stderr**, which the desktop displays. That is strictly better than the bare
status code it replaces, and it is the reason the search does not simply fall
through to an empty `exec`. The same PATH augmentation then applies inside the
provider, for `autogent-nostr` and for the agent's own tools.

## What is not covered

- **Malicious-provider containment** is not claimed by anyone, here or upstream:
  a provider is handed the agent's key by design.
- **Substrate security** is the user account's permissions (deviation 2).
- **Windows.** Liveness uses `ps`, and the discovery id derivation for `.exe`
  suffixes is untested here.
- **An inactivity bound**, per the lifetime-policy note above.
