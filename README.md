# autogent

Two binaries for running the [pi](https://pi.dev) coding agent
(`@earendil-works/pi-coding-agent`) inside a [Buzz](https://github.com/block/buzz)
community:

| Binary | What it is |
|---|---|
| **`autogent-nostr`** | Standalone headless service. Talks Nostr directly, embeds the Pi SDK in-process. |
| `buzz-backend-autogent` | Buzz Desktop backend provider. Deploys `autogent-nostr` as a local process, from the Desktop UI. |
| `buzz-backend-autogent-k8s` | Buzz Desktop backend provider. Deploys `autogent-nostr` as a Pod on a Kubernetes cluster (k3s / AKS), via the ambient kubeconfig. |

```
autogent-nostr:   Buzz Relay ──WS(NIP-42)──→ autogent-nostr ──in-process──→ Pi SDK AgentSession

autogent:         Buzz Desktop ──JSON/stdio──→ buzz-backend-autogent ──spawn──→ autogent-nostr

remote:           Buzz Desktop ──JSON/stdio──→ buzz-backend-autogent-k8s ──kubectl──→ Pod: autogent-nostr
                  config + OAuth creds travel as self-encrypted NIP-78 config records (kind 30078) over the relay
```

The ACP adapter that preceded this (`pi-acp` — an ACP server bridging `buzz-acp`
to `pi --mode rpc`) lives on in its own repository,
[wierdbytes/pi-acp](https://github.com/wierdbytes/pi-acp).

Install:

```bash
npm install && npm run build
npm link                  # → `autogent` + `autogent-nostr` on PATH (npm global bin)
npm run backend:install   # → `buzz-backend-autogent*` in `~/.local/bin`, where Buzz looks
```

Requires Node ≥ 22.19 and a working pi provider credential (`~/.pi/agent/auth.json`).

---

# autogent-nostr

A self-contained agent: it owns its Nostr identity, connects to the relay,
discovers its channel memberships, runs prompts through the Pi SDK, and publishes
replies — with no `buzz` CLI, no ACP transport, and no `pi` subprocess.

Design: [`docs/plans/20260803-standalone-nostr-agent.md`](docs/plans/20260803-standalone-nostr-agent.md).

## How it behaves

- **Replies are automatic.** Every completed visible assistant message is
  published as its own kind `9`. The model does not call a tool to send it, and
  cannot choose where it goes.
- **Every reply of a turn answers the user who started it.** Outputs after tool
  calls and after steering still target the original message, so the agent never
  builds a reply chain through its own posts.
- **A follow-up in the same thread steers the running turn** rather than queuing
  behind it. A message in a *different* thread waits its turn.
- **Thinking and tool activity never reach the channel.** They go to the owner
  only, NIP-44 encrypted as kind `24200`, where stock Buzz Desktop renders them.
- **Token usage** is published per turn as encrypted kind `44200`, with no
  transcript content.
- **Crash-safe.** Inputs are deduplicated and outputs are signed and stored
  before they are sent, so a restart re-sends identical bytes instead of
  producing a second message.
- **The owner steers it from the channel.** `!cancel`, `!rotate` and
  `!shutdown` are read before the prompt path, from the owner only, and only
  when the agent is `p`-tagged. The command has to be the whole message, but
  `@mentions` at either end are ignored — so `@Agent !shutdown` typed in Buzz
  works, while `remind me to !cancel that` stays an ordinary message.
- **Its channel list is published.** The kind `10100` roster entry carries
  `channel_ids` and is republished on every membership change; Buzz Desktop
  reads it to decide where to send `!shutdown` when you press Stop.

## Provisioning

The owner's secret key never touches the agent host. `attest` runs on the
owner's machine; everything else runs on the agent's.

```bash
# on the agent host
export AUTOGENT_RELAY_URL=wss://your-relay
autogent-nostr init --name "Pi Agent" --about "Autonomous Pi SDK agent"

# on the OWNER's machine, with the pairing request copied over
autogent-nostr attest pairing-request.json --out attestation.json

# back on the agent host
autogent-nostr provision import attestation.json
autogent-nostr doctor
autogent-nostr run
```

## Starting a deployed instance by hand

When the agent was deployed by Buzz Desktop through `buzz-backend-autogent`, its
identity, database and workspace live under `~/.buzz-autogent/instances/<id>/`.
`up` starts such an instance in the background without the desktop — useful when
Buzz will not offer Deploy (block/buzz#4730), or on a headless host:

```bash
autogent-nostr up --dry-run           # what would start, and where
autogent-nostr up --model 'opus[1m]'  # start it, detached
npm run agent:up -- --model 'opus[1m]'  # same, from a checkout
```

It runs the provider's own convergence, so `instance.json` ends up describing
the process that is actually running — pid, process signature and a fresh
generation — and the next desktop deploy adopts it instead of starting a second
copy. It waits for the agent's own `agent online` line before reporting success,
and it never reads the sealed key.

`--agent <pubkey>` picks the instance when the root holds more than one. Model,
system prompt and user env are not persisted by deploy, so pass them with
`--model`, `--system-prompt` and `--env KEY=VALUE`, or via `AUTOGENT_*`. Stop it
with `kill <pid>`: SIGTERM drains turns, publishes presence `offline` and closes
the relay cleanly. `autogent-nostr run` remains the foreground equivalent.

## Adding the agent to a channel

An agent cannot add itself — that needs an owner or admin signature, and the
owner key never reaches the agent host.

**Buzz Desktop cannot do this for a standalone agent.** Its add-members dialog
discards any agent that is not in the Desktop's own managed list
(`isAgentIdentityInManagedList` in
`desktop/src/features/agents/lib/agentAutocompleteEligibility.ts`), so an
externally-hosted agent never appears there — by name or by pubkey.

Run this **on the owner's machine** instead:

```bash
export AUTOGENT_RELAY_URL=wss://your-relay
autogent-nostr channel add --channel <channel-uuid>
# Owner secret key (hex or nsec1…):     ← typed, not echoed
```

`--pubkey` defaults to this host's agent and `--role` to `bot`. Removal is
`autogent-nostr channel remove --channel <uuid>`.

For unattended use the key can be passed as `--owner-private-key <hex|nsec>`,
but it then lands in shell history and is visible in `ps`; the command prints a
warning. `--owner-secret-file <path>` is the middle ground. The same three
sources work for `attest`.

This publishes kind `9000` (`h`/`p`/`role` tags), the relay updates the roster
and notifies the agent with kind `44100` — the running agent picks the channel
up live, no restart needed.

## Configuration

All via `AUTOGENT_*` environment variables. `autogent-nostr config` prints the
resolved configuration.

| Variable | Default | Meaning |
|---|---|---|
| `AUTOGENT_RELAY_URL` | `ws://localhost:3000` | Relay WebSocket URL |
| `AUTOGENT_STATE_DIR` | `~/.autogent-nostr` | Identity + database, mode `0700` |
| `AUTOGENT_RESPOND_TO` | `owner-only` | `owner-only` \| `allowlist` \| `anyone` \| `nobody` |
| `AUTOGENT_RESPOND_TO_ALLOWLIST` | — | Comma-separated pubkeys |
| `AUTOGENT_SUBSCRIBE` | `mentions` | `mentions` \| `all` |
| `AUTOGENT_CHANNELS` | all memberships | Restrict to these channel ids |
| `AUTOGENT_CWD` | `process.cwd()` | Working directory for the agent's tools |
| `AUTOGENT_MODEL` | pi's default | e.g. `anthropic/claude-sonnet-4-5` |
| `AUTOGENT_THINKING` | pi's default | Thinking level |
| `AUTOGENT_TOOLS` / `AUTOGENT_EXCLUDE_TOOLS` | — | Tool allow/deny lists |
| `AUTOGENT_EXTENSIONS` | — | Comma-separated pi extension sources (paths or `npm:`/`git:`). On k8s deploys the list comes from the deploy profile (interactive `autogent` CLI) via the config record (`autogent/config`); this env var overrides it |
| `AUTOGENT_READ_ROOTS` / `AUTOGENT_WRITE_ROOTS` | cwd | Filesystem sandbox roots |
| `AUTOGENT_COMMAND_DENYLIST` | — | Refused bash substrings |
| `AUTOGENT_MAX_CONCURRENT_TURNS` | `4` | Channels running a turn at once |
| `AUTOGENT_IDLE_TIMEOUT` | `900` | Seconds of silence before a turn aborts |
| `AUTOGENT_MAX_TURN_DURATION` | `7200` | Hard ceiling per turn, seconds |
| `AUTOGENT_CONTEXT_MESSAGE_LIMIT` | `12` | Prior messages fetched as context |
| `AUTOGENT_TELEMETRY` / `AUTOGENT_METRICS` | on | kind `24200` / kind `44200` publishing |
| `AUTOGENT_MAX_MESSAGE_BYTES` | `16000` | Largest chat body |
| `AUTOGENT_OVERSIZE_POLICY` | `split` | `split` \| `truncate` \| `reject` |
| `AUTOGENT_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

## Security posture

- Defaults are fail-closed: owner-only, mentions-only, and a channel whose type
  cannot be resolved is treated as a DM.
- **In a DM, every `respondTo` mode collapses to owner-plus-verified-siblings.**
  Clients auto-`p`-tag DM participants, so `anyone` would otherwise turn any DM
  into an open prompt channel.
- The Nostr secret is held only by the host signer. It is never placed in
  `process.env`, never passed to Pi tools, the shell or MCP servers, and the
  state directory is refused to the model's own file tools.
- The model controls no routing: channel, reply target, recipients, event kind
  and the NIP-OA tag all come from the verified turn context.

## Deviation from the design document

Plan §8.1 states that publishing an owner-attested kind `0` is sufficient for
stock Buzz Desktop to discover the agent. It is not. Desktop's roster comes from
`list_relay_agents`, which queries `{"kinds":[10100]}`
(`desktop/src-tauri/src/commands/agent_discovery.rs`); kind `0` is then read only
to resolve `ownerPubkey`. The agent therefore publishes **both** kind `0` and
kind `10100`, and `AGENT_PUBLISHED_KINDS` includes `10100` and `22242` so a
constrained attestation is rejected at boot rather than failing mid-flight.

## Tests

```bash
npm test          # 530 tests, no relay, no provider, no sockets
npm run typecheck
```

The suite includes golden fixtures for the Desktop transcript format, NIP-OA
spec vectors, a scripted in-process relay, deterministic clocks, and
crash-injection tests over the durable state machine.

---

# buzz-backend-autogent

A [Buzz Desktop backend provider](https://github.com/block/buzz/blob/main/docs/remote-agents.md)
that runs `autogent-nostr` as a detached process on this machine — so an agent
can be created, started and stopped from the Desktop UI instead of by hand.

It exists because provisioning a standalone agent is otherwise a three-machine
ritual (`init` → `attest` on the owner's box → `provision import`). Buzz Desktop
already owns an agent's key and its owner attestation; the provider protocol is
how it hands them to a launcher. This is that launcher.

```
Desktop ──{"op":"deploy", agent:{nsec, auth_tag, relay_url, launch:{…}}}──→ provider
provider ──seals identity into a 0700 state dir──→ spawns autogent-nostr (detached)
provider ──{"ok":true,"agent_id":"buzz-agent-‹pubkey12›"}──→ Desktop
```

After that the Desktop has **no channel to the process at all**: status is relay
presence, and Stop is the `!shutdown` message the agent already honours. That is
the protocol's design, not a shortcut — the relay was the management plane all
along.

## Use it from Buzz Desktop

```bash
npm run build && npm run backend:install
```

Then in Buzz Desktop: **New agent → Where to run → autogent**. The form is
pre-filled and every field is optional, so Start works with nothing typed.
Stopping the agent, restarting it, and editing it all work through the normal
Desktop controls.

`~/.local/bin` matters: Desktop scans its own directory, `PATH` and
`~/.local/bin`, and a Finder-launched app inherits launchd's minimal `PATH` —
which does not include your npm bin directory. `npm link` alone is enough only
when Desktop is started from a terminal.

That same minimal `PATH` has no `node` in it either, so the provider does not
rely on `#!/usr/bin/env node`: it ships as a `/bin/sh` script that is also valid
JavaScript, finds an interpreter (PATH, Homebrew, nvm, fnm, volta, asdf) and
`exec`s it on itself. If it finds none it says so on stderr instead of exiting
with a bare `127`.

## Use it without Desktop

The provider is a plain stdin/stdout program, so the whole loop runs from a
shell. `mint` fabricates a throwaway owner keypair and signs a real NIP-OA
attestation, which is everything a deploy request needs:

```bash
npm run dev-relay -- --port 3999          # a minimal relay, for testing only

node scripts/backend-run.mjs mint --relay ws://localhost:3999 --out /tmp/req.json
node scripts/backend-run.mjs deploy /tmp/req.json
node scripts/backend-run.mjs status /tmp/req.json
```

`deploy` runs the provider the way Desktop does — from a **staged copy** of the
bundle in a temp directory — because that is the one property a plain `node
dist/…` invocation would fail to exercise.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `command` | `autogent-nostr` | Name or absolute path of the agent binary |
| `state_root` | `~/.buzz-autogent` | Instance root, and the deployment scope |
| `workspace` | per-agent dir | Working directory for the agent's tools |
| `startup_timeout_seconds` | `120` | How long Start waits for the agent to report itself online |
| `log_level` | `info` | Written to the instance log |

Each deployed agent gets `<state_root>/instances/<pubkey12>/` holding its sealed
identity, its database, its workspace and `agent.log`.

## Behaviour worth knowing

- **Start on a running agent is a strict no-op.** It returns the same id and
  mutates nothing — pressing Start twice must never kill an agent mid-turn. The
  cost is that configuration edits reach a running agent only when it next exits.
- **Success means the agent came up**, not that a process was spawned: the
  provider waits for the agent's own "agent online" line.
- **The timeout never destroys anything.** A slow start is left alone and adopted
  by the next Start. What replaces a never-started instance is a *changed*
  configuration — which is what makes a wedged instance fixable.
- **The key is never in the environment.** It is sealed into the state directory
  (0600) the way `provision import` would. Anything running as your user can
  still read that file; the isolation unit is the user account.
- **Nothing restarts the agent.** A clean stop stays stopped; an accidental death
  shows up as presence `offline` and is revived by pressing Start.

The full contract, the substrate mapping and the deviations from the Kubernetes
binding are in [`docs/buzz-backend-autogent.md`](docs/buzz-backend-autogent.md).

---

# buzz-backend-autogent-k8s (remote nodes)

Deploys the same agent to a Kubernetes substrate. Design:
[`docs/plans/20260804-remote-nodes.md`](docs/plans/20260804-remote-nodes.md);
operations: [`docs/runbook-remote.md`](docs/runbook-remote.md).

The shape of it:

- **Relay-first bootstrap.** The cluster holds exactly one secret — the
  bootstrap triple (`AUTOGENT_NSEC`, `AUTOGENT_RELAY_URL`, `AUTOGENT_AUTH_TAG`).
  Everything else — model, prompt, respond-to policy, the Anthropic OAuth
  credential — lives on the relay as NIP-78 config records (kind `30078`,
  slugs `autogent/config` and `autogent/auth`): addressable events signed by the
  agent key, NIP-44-encrypted to *itself*, with HMAC-derived `d` tags. Only
  holders of the agent nsec (the agent and the owner-side deploy tooling) can
  read, address or write them, and nothing on the wire links them to the
  owner pubkey — they carry no `p` tag and no NIP-OA auth tag. The agent
  reads them at boot and hot-applies changes; `autogent-nostr config publish`
  pushes a new config version without a redeploy. Missing heads ⇒ the agent
  starts *degraded*: visible, stoppable, refusing prompts.
- **No management channel to the node.** Status is presence on the relay,
  stop is owner `!shutdown`, lifetime is bounded by the in-harness
  `exit-after-inactivity` timer, restart-on-crash is `restartPolicy`.
- **Agents are configured in the `autogent` CLI, not the GUI.** The interactive
  `autogent` command owns the registry of *deploy profiles*: a wizard collects
  every substrate parameter (kube context picked from the ambient kubeconfig,
  namespace, image, storage, idle timeout — Enter accepts the default) and runs
  the mandatory pi/Anthropic OAuth login. Buzz Desktop's provider form is
  reduced to a single `agent` field — a drop-down over the registry. The Nostr
  identity is still minted by Buzz Desktop when the agent record is added; it
  is bound to the profile on first deploy, which also adopts the profile's
  OAuth credential under the one-account-one-agent rule.
- **Credentials** are captured by the wizard's login step (pi's OAuth flow) and
  published as the provider-auth record at deploy. `autogent-nostr auth login
  --agent <pubkey>` remains the per-identity escape hatch. The agent writes
  refreshed tokens back, so a Pod recreated with an empty PVC recovers them
  from the relay.
- **Relay tools** in the Pod: `channel_history`/`channel_search` (NIP-50),
  `media_get`/`media_put` (Blossom), `git_repos` + a loopback NIP-98 auth proxy
  that lets the stock `git` CLI clone/push the relay's repos without the key
  ever entering the bash environment, and `send_message` (cross-posting through
  the durable outbox).

Setup, in order:

```bash
# once, on the VM:                deploy/k3s-bootstrap.sh
# once, on the owner machine:     merge kubeconfig, rename context (script prints how)
npm run backend:install           # links both providers into ~/.local/bin
npm link                          # puts `autogent` on PATH (npm global bin)
autogent                          # interactive: create an agent profile
                                  # (kube context, namespace, image, storage,
                                  #  idle timeout + mandatory OAuth login)
# then in Buzz Desktop: add an agent, provider "autogent-k8s", pick the
# profile in the drop-down — the only provider setting left there — Deploy
```

Manifests for the namespace and the egress NetworkPolicy are in
[`deploy/k8s/`](deploy/k8s/).
