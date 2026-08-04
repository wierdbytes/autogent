# Standalone Nostr Agent на Pi SDK — план реализации

**Дата:** 2026-08-03  
**Статус:** Design / implementation plan  
**Рабочее имя:** `autogent-nostr`  
**Репозиторий реализации:** текущий `pi-acp`  
**Изменения в Buzz:** не планируются

---

## 0. Кратко

Цель — превратить текущий проект в самодостаточный headless-сервис, который напрямую соединяет Buzz/Nostr с `@earendil-works/pi-coding-agent`:

```text
Stock Buzz Desktop ─┐
                    │ existing Nostr events
Other Nostr clients ├────────── Buzz relay ────────── autogent-nostr
                    │                                  ├── Nostr transport
                    │                                  ├── channel/thread scheduler
                    │                                  ├── Pi AgentSession registry
                    │                                  ├── chat output publisher
                    │                                  ├── observer telemetry
                    │                                  └── durable state/outbox
                    └──────────────────────────────────────────────────────────
```

В runtime отсутствуют:

- `buzz-acp`;
- ACP transport и ACP session lifecycle;
- `pi --mode rpc` subprocess;
- обязательный `buzz` CLI или MCP для чтения и отправки сообщений;
- `send_message` tool, который модель должна вызвать для обычного ответа.

Видимый текст модели автоматически публикуется как kind `9`. Thinking, tool activity и рабочий журнал отправляются owner'у как NIP-44 encrypted kind `24200`. Usage публикуется как durable encrypted kind `44200`.

Существующий Buzz Desktop не меняется. Чтобы его текущий observer UI отображал Pi-события, сервис публикует ACP-shaped **compatibility telemetry**. Это только wire-представление существующего observer schema, а не использование ACP внутри runtime.

---

## 1. Зафиксированные продуктовые решения

### 1.1 Один процесс и прямой Pi SDK

Целевая цепочка:

```text
Nostr EVENT → ChannelActor → AgentSession.prompt()/steer()
                              ↓ AgentSessionEvent
              kind 9 / kind 24200 / kind 44200
```

`AgentSession` создаётся через Pi SDK (`createAgentSessionRuntime()` либо services API), а не через дочерний `pi` процесс.

### 1.2 Автоматический chat output

Каждое полностью завершённое видимое assistant message:

- извлекается на Pi `message_end`;
- публикуется отдельным kind `9`;
- не требует tool call;
- не включает thinking;
- не стримится в чат до завершения сообщения;
- сначала фиксируется в durable outbox, затем отправляется в relay.

Tool-only assistant messages и пустой visible text не создают kind `9`.

### 1.3 Reply target никогда не является сообщением агента

Активный turn имеет неизменяемое первичное пользовательское сообщение:

```ts
interface TurnContext {
  turnId: string;
  channelId: string;
  threadRootEventId: string;
  primaryTriggerEventId: string;
  primaryAuthorPubkey: string;
  acceptedInputEventIds: string[];
  participantPubkeys: string[];
}
```

Все assistant outputs этого turn отвечают **на `primaryTriggerEventId`**, включая outputs после tool calls и после steering messages:

```text
User A (primary trigger)
  ├── Agent output 1 ──reply──→ User A
  ├── Agent output 2 ──reply──→ User A
  ├── User B follow-up in same thread ──steer──→ active Pi turn
  └── Agent output 3 ──reply──→ User A
```

Агент не создаёт reply-chain через собственные сообщения.

Для последующих outputs после steer:

- NIP-10 `reply` остаётся равен первичному пользовательскому event;
- root остаётся root исходного треда;
- `p` tags включают primary author и авторов принятых steering messages, чтобы участники не потеряли уведомления;
- дубликаты `p` удаляются.

### 1.4 Same-thread follow-up становится steer

Если новый разрешённый kind `9` приходит, пока агент обрабатывает **тот же тред**, событие не ждёт нового turn:

1. проходит signature, membership, author, mention и dedup gates;
2. durable-записывается как input текущего turn с ролью `steer`;
3. добавляется в `TurnContext.acceptedInputEventIds` и `participantPubkeys`;
4. передаётся в текущий `AgentSession` через `session.steer(...)`;
5. отражается в observer telemetry как совместимый `_goose/unstable/session/steer` frame.

Тред идентифицируется ключом:

```text
ConversationKey = relayId + channelId + canonicalThreadRootEventId
```

Где `canonicalThreadRootEventId`:

- NIP-10 root из входного event, если он корректен;
- иначе ID самого top-level event.

Если активен другой тред того же канала, новое сообщение ставится в очередь и не steer'ит чужую работу. После завершения текущего turn оно запускает отдельный turn со своим `primaryTriggerEventId`.

Если same-thread сообщение приходит уже после обработанного `agent_settled`, оно начинает новый turn. Граница определяется порядком событий внутри per-channel actor, а не приблизительной проверкой таймеров.

### 1.5 Buzz и Buzz Desktop не изменяются

Нельзя рассчитывать на:

- новый observer event schema в Desktop;
- новую runtime integration в Desktop;
- изменение provisioning UI;
- патчи relay/client code в Buzz repository.

Сервис должен работать с существующими Nostr kinds, NIPs и observer payloads.

---

## 2. Что берём из `buzz-acp` как поведенческую спецификацию

Полезная часть `buzz-acp` — Nostr orchestration и hardening, а не ACP:

- `crates/buzz-acp/src/relay.rs`
  - NIP-42;
  - reconnect/backoff;
  - startup watermark;
  - replay floors и resubscribe;
  - rate-limit handling;
  - dynamic memberships.
- `crates/buzz-acp/src/lib.rs`
  - self-loop prevention;
  - `respond_to` gate;
  - `!cancel`, `!shutdown`, `!rotate`;
  - presence kind `20001`;
  - graceful shutdown.
- `crates/buzz-acp/src/pool.rs`
  - per-channel single-flight;
  - thread/DM context enrichment;
  - retries, deadlines, dead-letter handling;
  - observer lifecycle и NIP-AM metrics.
- `crates/buzz-acp/src/observer.rs`
  - `ObserverEvent` envelope;
  - process/session sequence;
  - `channelId`, `sessionId`, `turnId`, `startedAt`.

Код напрямую не переносится из Rust. Его поведение фиксируется собственными TypeScript tests и protocol fixtures.

Не переносим:

- `acp.rs` transport;
- subprocess pool;
- ACP initialize/capability negotiation;
- ACP request/response lifecycle;
- ACP permission round-trips.

Существующий `crates/buzz-agent` также не является direct Nostr runtime: это ACP model runtime через stdin/stdout.

---

## 3. Границы самодостаточности

Сервис самостоятельно владеет:

- agent keypair после provisioning;
- локальным encrypted/sealed configuration store;
- kind `0` profile reconciliation;
- NIP-OA verification;
- NIP-42 authentication;
- relay connection и subscriptions;
- memberships discovery;
- direct Nostr reads/writes;
- Pi sessions;
- input scheduling и steering;
- outputs, telemetry, metrics, presence;
- local persistence и crash recovery;
- controls и graceful shutdown.

Есть три неустранимые внешние границы:

1. **Owner attestation.** Агент не может подписать NIP-OA owner key'ем.
2. **Закрытые memberships.** Агент не может сам добавить себя в закрытый channel без admin/owner действия.
3. **LLM credentials.** Оператор должен предоставить доступ к выбранному provider.

Owner private key никогда не передаётся работающему agent runtime.

---

## 4. Provisioning без зависимости от Buzz Desktop

Один executable предоставляет несколько режимов:

```bash
autogent-nostr init
autogent-nostr attest pairing-request.json --out attestation.json
autogent-nostr provision import attestation.json
autogent-nostr profile sync
autogent-nostr doctor
autogent-nostr run
```

### 4.1 `init` на машине агента

- генерирует agent keypair;
- создаёт локальный state directory с правами `0700`;
- сохраняет secret в keychain/sealed file с правами `0600`;
- создаёт pairing request без секретов:

```json
{
  "version": 1,
  "agentPubkey": "<hex>",
  "relayUrl": "wss://relay.example",
  "profile": {
    "name": "Pi Agent",
    "about": "Autonomous Pi SDK agent"
  },
  "nonce": "<random>"
}
```

### 4.2 `attest` на машине owner'а

Эта команда может быть частью того же npm package, но выполняется отдельно от runtime:

- проверяет pairing request;
- принимает owner signer только локально;
- создаёт NIP-OA tag для agent pubkey;
- по умолчанию использует пустые conditions `""`, так как агент публикует несколько kinds;
- не отправляет owner secret на agent host;
- возвращает signed provisioning artifact.

### 4.3 `provision import` на машине агента

- проверяет структуру NIP-OA tag;
- BIP-340 signature;
- соответствие agent pubkey локальному secret;
- owner != agent;
- conditions применимы ко всем необходимым events;
- сохраняет owner pubkey и canonical auth tag.

### 4.4 Profile reconciliation

После provisioning runtime подписывает своим ключом и публикует kind `0` с ровно одним NIP-OA `auth` tag. На старте он:

- запрашивает актуальный kind `0`;
- проверяет owner provenance;
- публикует обновление только при отсутствии или drift профиля;
- никогда не публикует owner-authored event.

Валидный owner-attested kind `0` позволяет stock Buzz Desktop обнаружить standalone agent как relay-owned agent без изменения Desktop.

---

## 5. Runtime state machines

### 5.1 Process lifecycle

```text
BOOT
  → LOAD_IDENTITY
  → VERIFY_PROVISIONING
  → OPEN_DATABASE
  → CREATE_PI_SERVICES
  → CONNECT_RELAY
  → NIP42_AUTHENTICATE
  → RECONCILE_PROFILE
  → DISCOVER_MEMBERSHIPS
  → SUBSCRIBE
  → RECOVER_OUTBOX
  → PUBLISH_ONLINE
  → RUNNING
  → DRAINING
  → PUBLISH_OFFLINE
  → STOPPED
```

`online` означает, что identity проверена, Pi runtime готов, memberships обнаружены и channel subscriptions установлены.

### 5.2 Relay connection

```text
DISCONNECTED
  → CONNECTING
  → AUTHENTICATING
  → SUBSCRIBING
  → READY
  → BACKING_OFF
  → CONNECTING
```

Требования:

- bounded startup retries с понятной ошибкой;
- unbounded reconnect после успешного старта;
- exponential backoff + jitter;
- повторный NIP-42 на новом socket;
- восстановление subscriptions;
- сохранение per-channel replay floor;
- overlap replay window + event-id dedup;
- terminal classification для auth/provisioning failures.

### 5.3 Per-channel actor

Все входные Nostr events и значимые Pi lifecycle events сериализуются через mailbox одного `ChannelActor`. Это устраняет race между `agent_settled` и новым same-thread event.

Состояния:

```text
IDLE
  → STARTING_TURN
  → RUNNING(threadKey, turnContext)
  → SETTLING
  → IDLE
```

Правила входного event:

| Состояние | Тред | Действие |
|---|---|---|
| `IDLE` | любой | новый primary turn |
| `RUNNING` | тот же | `AgentSession.steer()` |
| `RUNNING` | другой | durable queue |
| `SETTLING` до terminal event | тот же и Pi ещё streaming | steer |
| после `agent_settled` | любой | новый turn/queue head |

`session.isStreaming` используется как sanity check, но authoritative ordering задаёт actor state.

### 5.4 Turn lifecycle

```text
CREATED
  → PRIMARY_PROMPT_ACCEPTED
  → RUNNING
  ↔ STEERING_RECEIVED
  → AGENT_SETTLED
  → OUTPUTS_DRAINED
  → METRIC_ENQUEUED
  → COMPLETED
```

Turn закрывается только на Pi `agent_settled`, а не на `agent_end`, потому что после `agent_end` возможны retry, compaction или queued continuation.

---

## 6. Nostr transport и protocol contracts

### 6.1 Реализация клиента

Рекомендуется использовать `nostr-tools` для primitives:

- event ID/signature;
- key encoding;
- NIP-44;
- NIP-10 helpers, где подходят.

WebSocket supervisor реализуется в сервисе, чтобы явно контролировать:

- `REQ`, `EVENT`, `CLOSE`, `AUTH`;
- NIP-42 challenge lifecycle;
- subscriptions IDs;
- `EOSE`, `OK`, `NOTICE`, `CLOSED`;
- replay floors;
- publish acknowledgements;
- rate-limit behavior.

Не использовать Buzz HTTP API или Buzz CLI для основного transport path.

### 6.2 NIP-OA injection

Все обычные signed agent events получают ровно один verified `auth` tag. Builder запрещает caller'ам самостоятельно добавлять второй `auth` tag.

При старте сервис проверяет, что conditions подходят минимум для:

- kind `0`;
- kind `9`;
- kind `20001`;
- kind `24200`;
- kind `44200`.

Так как текущая grammar не выражает OR между несколькими kinds, рекомендуемый provisioning tag имеет пустые conditions.

### 6.3 Membership discovery

Startup:

- capture startup watermark до открытия event stream;
- query kind `39002` с `#p = agent`;
- resolve channel metadata kind `39000`;
- subscribe к membership notifications kinds `44100`/`44101`;
- динамически добавлять/удалять channel subscriptions.

При removal:

- прекратить принимать новые events;
- отменить active turn этого channel;
- удалить queued work;
- закрыть subscription;
- архивировать, но не обязательно удалять Pi session.

### 6.4 Inbound kind `9` pipeline

```text
signed EVENT
  → validate NIP-01 id/sig
  → kind == 9
  → parse h/channel
  → known active membership
  → startup/replay floor
  → durable dedup by event id
  → reject event.pubkey == agent pubkey
  → resolve channel type
  → respond_to gate
  → subscription rule (mentions/all)
  → parse canonical thread root
  → ChannelActor
```

Default security posture:

- `respond_to = owner-only`;
- subscription mode `mentions`;
- unknown channel type считается private/DM и обрабатывается fail-closed;
- owner и explicitly configured sibling agents могут быть разрешены отдельно;
- malformed thread tags не переиспользуются как доверенные routing data.

### 6.5 Outbound kind `9`

На каждый завершённый visible assistant message создаётся один output intent.

Tags строятся только из immutable `TurnContext`:

- `h = channelId`;
- NIP-10 root = `threadRootEventId`;
- NIP-10 reply = `primaryTriggerEventId`;
- `p` = deduplicated accepted participant pubkeys;
- один NIP-OA `auth` tag.

Не допускаются:

- reply на ранее опубликованный agent output;
- перенос произвольных входных tags;
- повторная отправка thinking как chat text;
- отправка незавершённого text delta;
- model-controlled tags/channel/reply target.

Output publisher работает последовательно по `(turnId, ordinal)`. В outbox сохраняется signed event; retry повторяет тот же event ID.

### 6.6 Presence kind `20001`

- `online` после полной readiness;
- heartbeat `online` каждые 60 секунд;
- `offline` best-effort при graceful shutdown;
- presence publish идёт через WebSocket, так как kind ephemeral.

### 6.7 Observer kind `24200`

Wire event следует текущему NIP-AO:

```json
{
  "kind": 24200,
  "pubkey": "<agent>",
  "content": "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p", "<owner>"],
    ["agent", "<agent>"],
    ["frame", "telemetry"],
    ["h", "<channel-id>"]
  ]
}
```

Decrypted `ObserverEvent`:

```json
{
  "seq": 42,
  "timestamp": "2026-08-03T12:00:00.123Z",
  "kind": "acp_read",
  "agentIndex": 0,
  "channelId": "<uuid>",
  "sessionId": "<pi-session-id>",
  "turnId": "<turn-id>",
  "startedAt": "2026-08-03T11:59:55.000Z",
  "payload": {}
}
```

Kind `24200` остаётся ephemeral. Полнота гарантируется только для live observer, который был подключён. Сервис не пытается превратить NIP-AO в durable transcript.

### 6.8 Usage kind `44200`

После каждого завершённого turn:

- суммировать usage всех model calls turn;
- вычислить per-turn и session-cumulative counters;
- сформировать NIP-AM payload;
- NIP-44 encrypt agent→owner;
- durable-записать signed event в outbox;
- публиковать ровно один metric при наличии observed usage.

`h` tag не добавляется; channel metadata находится внутри encrypted payload.

### 6.9 Controls

Сервис подписывается на owner→agent kind `24200`, `frame=control` и проверяет:

- подпись event;
- `pubkey == owner`;
- `p == agent`;
- `agent` tag;
- freshness;
- NIP-44 decryption;
- payload size.

Минимум:

- `cancel_turn` → `session.abort()` для channel;
- `switch_model` compatibility extension → безопасный model resolution и `control_result`;
- неизвестные control types игнорируются.

Chat controls из owner-mentioned kind `9`:

- `!cancel`;
- `!shutdown`;
- `!rotate`.

Они обрабатываются до обычной prompt queue, но только после строгой owner/agent mention проверки.

---

## 7. Pi SDK integration

### 7.1 Session registry

MVP:

```text
SessionKey = relayId + channelId
```

Одна persistent Pi session на channel сохраняет общий channel context. Thread isolation обеспечивается scheduler'ом: только сообщения активного thread могут steer'ить running turn; другие threads ждут.

`SessionRegistry`:

- lazy создаёт `AgentSession`;
- открывает сохранённую session через `SessionManager` после restart;
- хранит session ID/path;
- подписывает event listener до первого prompt;
- освобождает ресурсы при shutdown/removal;
- поддерживает owner-triggered rotation.

### 7.2 Initial prompt

Primary event вызывает:

```ts
await session.prompt(formattedPrompt, {
  source: "rpc",
  expandPromptTemplates: false,
});
```

Prompt formatter добавляет структурированный, недоверенный context:

- channel ID/name/type;
- thread root;
- author pubkey/display name;
- source event ID/timestamp;
- fetched thread/DM history;
- message body.

Пользовательский текст не смешивается с system instructions.

### 7.3 Steering

Same-thread follow-up вызывает:

```ts
await session.steer(formattedSteeringMessage);
```

Pi доставляет steer после завершения текущих assistant tool calls и до следующего LLM call.

Перед вызовом:

1. input event фиксируется в SQLite;
2. actor подтверждает, что `ConversationKey` совпадает;
3. event добавляется к active turn;
4. observer получает synthetic steer frame;
5. затем вызывается `session.steer()`.

Если `steer()` отвергнут из-за terminal race:

- actor повторно проверяет session/turn state;
- если старый turn уже settled, event атомарно переводится из `steer_pending` в normal queued primary event;
- событие не теряется и не доставляется дважды.

### 7.4 Event subscription

Основные Pi events:

| Pi event | Действие |
|---|---|
| `agent_start` | lifecycle telemetry |
| `turn_start` | model-call accounting boundary |
| `message_update` text | live observer `agent_message_chunk` |
| `message_update` thinking | live observer `agent_thought_chunk` |
| `message_end` assistant | durable chat output intent |
| `tool_execution_start` | observer `tool_call` |
| `tool_execution_update` | observer partial tool update |
| `tool_execution_end` | observer `tool_call_update` terminal |
| retry/compaction events | compatible diagnostic/raw frame |
| `agent_end` | record retry state, не закрывать turn |
| `agent_settled` | actor terminal event, close turn |

### 7.5 Visible message extraction

На `message_end`:

- принять только assistant role;
- извлечь text content blocks в исходном порядке;
- исключить thinking blocks и tool calls;
- trim только для проверки пустоты, но не менять meaningful formatting;
- не публиковать aborted/error-only message без нормального visible text;
- присвоить стабильный `(turnId, piMessageId, ordinal)` logical key;
- синхронно сохранить output intent.

Pi документирует, что `message_end` происходит до его внутреннего session persistence, поэтому listener должен сначала durable-зафиксировать intent, не дожидаясь async relay publish.

### 7.6 Permissions и extension UI

Stock Desktop не получает новый permission protocol. Поэтому runtime не должен зависеть от интерактивных запросов:

- tool policy задаётся конфигурацией/inline extension;
- опасные tools запрещаются до запуска;
- разрешённые tools выполняются автономно;
- extension UI requests получают deterministic non-blocking policy response либо отклоняются;
- `session/request_permission` не используется как реальный control plane.

---

## 8. Совместимость с неизменённым Buzz Desktop

### 8.1 Почему Desktop обнаружит agent

Текущий Desktop объединяет:

- локально managed agents;
- relay agents с валидным NIP-OA owner, совпадающим с current identity.

Следовательно, standalone agent должен корректно публиковать kind `0` с owner attestation. После этого Desktop рассматривает его как deployed relay-owned agent и подписывается на owner-scoped observer frames.

### 8.2 Compatibility mapper

Отдельный модуль:

```text
src/telemetry/buzz-desktop-compat.ts
```

преобразует Pi events в payloads, которые уже понимает `agentSessionTranscript.ts`.

Это сериализация для viewer compatibility, а не ACP transport.

| Семантика | `ObserverEvent.kind` | Payload |
|---|---|---|
| session ready | `session_resolved` | существующая session metadata shape |
| primary prompt | `acp_write` | JSON-RPC-shaped `session/prompt` |
| same-thread steer | `acp_write` | `_goose/unstable/session/steer` |
| visible delta | `acp_read` | `session/update: agent_message_chunk` |
| thinking delta | `acp_read` | `session/update: agent_thought_chunk` |
| tool start | `acp_read` | `session/update: tool_call` |
| tool progress/end | `acp_read` | `session/update: tool_call_update` |
| usage progress | `acp_read` | `session/update: usage_update` |
| turn start | `turn_started` | triggering event IDs, source |
| liveness | `turn_liveness` | `{}` |
| turn terminal | `turn_completed` | `{}` |
| failure | `turn_error` | outcome/error/code |
| unrepresentable diagnostics | `raw_json_rpc` | bounded normalized Pi event |

Synthetic frames должны сохранять current Desktop parsing conventions для:

- user event ID;
- author pubkey;
- prompt sections;
- message ID;
- tool call ID;
- tool args/result;
- timestamps и sequence.

### 8.3 Telemetry batching

- coalesce text/thinking deltas в коротком окне, например 25–50 ms;
- не превышать relay recommendation 100 frames/sec/agent;
- decrypted payload < 65,535 bytes;
- большие textual tool results разбивать на ordered chunks;
- binary data не отправлять raw, а отражать metadata/hash;
- при локальном overflow публиковать видимый diagnostic вместо silent drop;
- heartbeat `turn_liveness` для тихих долгих операций.

### 8.4 Stock Desktop acceptance

Без изменения Buzz repository существующий Desktop должен:

- показывать agent profile как owner-owned relay agent;
- видеть presence;
- показывать working indicator;
- отображать user prompt;
- отображать steer как последующее пользовательское сообщение;
- стримить thinking;
- отображать tools и results;
- показывать visible assistant activity;
- получать обычные chat kind `9` messages;
- завершать active-turn indicator на `turn_completed`;
- отображать kind `44200` в существующем metrics surface, если он включён.

---

## 9. Durable state и crash recovery

Рекомендуемая база — SQLite в WAL mode.

### 9.1 Tables

```text
identity_metadata
  agent_pubkey, owner_pubkey, auth_tag_hash, profile_hash

channels
  relay_id, channel_id, status, metadata_json,
  pi_session_id, pi_session_path, last_seen_created_at

inbox
  event_id PRIMARY KEY, channel_id, thread_root_id,
  author_pubkey, created_at, received_at,
  disposition, turn_id, input_ordinal, raw_event_json

turns
  turn_id PRIMARY KEY, channel_id, thread_root_id,
  primary_trigger_event_id, primary_author_pubkey,
  state, started_at, settled_at, stop_reason

turn_inputs
  turn_id, event_id, role(primary|steer), ordinal,
  delivery_state, delivered_at

output_intents
  logical_id PRIMARY KEY, turn_id, pi_message_id, ordinal,
  content, reply_event_id, root_event_id,
  participant_pubkeys_json, state

outbox
  logical_id PRIMARY KEY, event_id, kind,
  signed_event_json, state, attempts, next_retry_at, last_error

observer_state
  session_id, next_seq

usage_baselines
  session_id, turn_seq, counters_json
```

### 9.2 Inbox semantics

- event ID уникален глобально для instance;
- dedup выполняется до prompt/steer;
- `steer_pending` записывается до `AgentSession.steer()`;
- success переводит его в `steer_delivered`;
- terminal race переводит в `queued` без повторной вставки;
- completed turn отмечает все delivered inputs terminal.

### 9.3 Outbox semantics

1. `message_end` создаёт `output_intent`.
2. Publisher строит event из immutable turn snapshot.
3. Event подписывается один раз.
4. Signed JSON и event ID записываются до network send.
5. После relay `OK` state становится `published`.
6. Lost `OK` приводит к повтору того же signed event, а не к созданию нового ID.

Это даёт effectively-once Nostr publish при relay dedup по event ID.

### 9.4 Recovery interrupted turn

После restart:

- отправить все pending signed outbox events;
- открыть сохранённые Pi sessions;
- turns в `RUNNING/SETTLING` отметить `interrupted`;
- сверить output logical IDs с Pi session history;
- уже зафиксированные outputs не создавать повторно;
- недоставленные primary/steer inputs восстановить в порядке `input_ordinal`;
- создать recovery turn с тем же primary reply target либо явно dead-letter при исчерпанном retry budget;
- отправить owner'у diagnostic telemetry после reconnect.

Полной exactly-once model execution достичь нельзя, но публикация chat events и input dedup должны быть детерминированными.

---

## 10. Security model

### 10.1 Secret isolation

- не хранить agent nsec в обычном config JSON;
- не оставлять `BUZZ_PRIVATE_KEY`/`NOSTR_PRIVATE_KEY` в `process.env` после bootstrap;
- не передавать Nostr secret в Pi tools, shell или MCP environment;
- Nostr signing выполняется host-owned signer module;
- child process environment строится allowlist'ом;
- decrypted NIP-44 content не логируется на INFO и выше;
- redaction применяется к diagnostics и crash reports.

Production-вариант: OS keychain, inherited sealed file descriptor или отдельный signer broker.

### 10.2 Prompt injection boundary

Модель не управляет:

- relay URL;
- Nostr secret;
- channel ID;
- reply/root tags;
- recipients telemetry;
- NIP-OA tag;
- event kind;
- outbox retries.

Все routing fields берутся только из проверенного `TurnContext`.

### 10.3 Tool sandbox

Remote autonomous agent должен запускаться с:

- ограниченным cwd;
- configurable read/write roots;
- command denylist/allowlist;
- sanitized environment;
- execution timeout;
- output size limits;
- optional container/sandbox boundary.

Interactive permission UI не считается security boundary.

### 10.4 Author gate

Modes:

- `owner-only` — default;
- `allowlist`;
- `anyone`;
- `nobody`.

Для DM любой mode, кроме `nobody`, дополнительно требует owner/sibling trust policy. Unknown channel metadata не ослабляет gate.

---

## 11. Предлагаемая структура проекта

```text
src/
  main.ts
  cli.ts
  config.ts

  provisioning/
    init.ts
    attest.ts
    import.ts
    identity-store.ts
    doctor.ts

  nostr/
    types.ts
    signer.ts
    relay-supervisor.ts
    nip42.ts
    nip44.ts
    profile.ts
    memberships.ts
    subscriptions.ts
    thread-tags.ts
    event-builder.ts
    publisher.ts
    presence.ts
    controls.ts

  runtime/
    app-runtime.ts
    session-registry.ts
    channel-registry.ts
    channel-actor.ts
    scheduler.ts
    conversation-key.ts
    turn-context.ts
    prompt-formatter.ts
    pi-event-router.ts
    output-router.ts
    context-fetcher.ts

  telemetry/
    observer-envelope.ts
    observer-publisher.ts
    buzz-desktop-compat.ts
    telemetry-buffer.ts
    usage-tracker.ts
    usage-publisher.ts

  state/
    database.ts
    migrations.ts
    inbox-repository.ts
    turn-repository.ts
    outbox-repository.ts
    recovery.ts

  security/
    author-gate.ts
    tool-policy.ts
    secret-vault.ts
    redaction.ts
```

Existing ACP implementation можно временно оставить отдельным legacy binary. Новый direct runtime не должен импортировать `src/acp-server.ts`, `src/pi-process.ts` или ACP translation code. Финальная судьба legacy binary решается отдельно после стабилизации direct runtime.

---

## 12. Implementation phases

### Phase 0 — Protocol contracts и fixtures

- зафиксировать TS types для Nostr events, ObserverEvent и NIP-AM;
- добавить NIP-OA/NIP-44 test vectors;
- добавить golden fixtures, которые понимает текущий Buzz Desktop;
- зафиксировать NIP-10 root/reply behavior;
- создать fake relay и deterministic signer clock.

**Exit:** fixtures проходят без реального relay и Pi provider.

### Phase 1 — Direct Pi runtime без Nostr network

- создать `AgentSession` напрямую через SDK;
- session registry;
- event subscription;
- visible-message extraction;
- primary prompt и same-thread steer state machine;
- fake inbound events и fake publisher.

**Exit:** тест показывает primary prompt, steer в тот же session и несколько outputs, каждый с reply target primary user event.

### Phase 2 — Identity и direct relay transport

- provisioning commands;
- sealed identity store;
- profile publication;
- WebSocket/NIP-42;
- membership discovery;
- kind `9` subscriptions;
- event validation/dedup;
- presence.

**Exit:** standalone process после одного owner attestation подключается без Buzz CLI/Desktop launcher и получает реальные channel messages.

### Phase 3 — Scheduler, threads и steering

- per-channel actors;
- canonical conversation keys;
- same-thread steer;
- different-thread queue;
- settle/steer race handling;
- cancel/rotate/shutdown;
- concurrency semaphore.

**Exit:** E2E race tests доказывают отсутствие lost/duplicate steering inputs.

### Phase 4 — Chat output и durable outbox

- immutable TurnContext snapshot;
- kind `9` builder;
- NIP-10 root/reply tags;
- participant `p` tags;
- output intents;
- signed-event outbox;
- retry/OK handling;
- crash injection tests.

**Exit:** все outputs, включая outputs после steer, отвечают primary user event и никогда не отвечают agent event.

### Phase 5 — Existing Desktop observer compatibility

- NIP-AO publisher;
- ACP-shaped compatibility mapper;
- prompt/steer/text/thinking/tool/usage mappings;
- telemetry coalescing/chunking;
- liveness;
- stock Desktop manual E2E.

**Exit:** unmodified Desktop отображает полный live transcript и working state.

### Phase 6 — NIP-AM metrics и controls

- per-call/turn/cumulative usage;
- kind `44200` outbox;
- cancel control;
- switch-model compatibility;
- control_result frames.

**Exit:** stock Desktop видит metrics и может отменить active turn.

### Phase 7 — Production hardening

- reconnect/resubscribe parity;
- dynamic memberships;
- timeout/dead-letter policies;
- rate-limit backpressure;
- secret isolation;
- sandboxing;
- observability/health endpoint;
- soak and fault-injection tests.

---

## 13. Test plan

### 13.1 Thread/reply invariants

- три assistant messages одного turn → три kind `9`, все reply primary event;
- ни один output не имеет reply tag на agent pubkey event;
- root сохраняется для nested thread;
- top-level trigger даёт корректные root/reply tags;
- steer author добавляется в `p`, reply target не меняется;
- malformed NIP-10 tags fail-safe создают новый canonical root.

### 13.2 Steering

- same channel + same root + running → `session.steer()`;
- same channel + different root → queue;
- different channel → независимый worker при наличии capacity;
- same-thread event после settled → новый primary turn;
- steer/settled race не теряет event;
- duplicate steer event ID не доставляется дважды;
- disallowed author не может steer;
- self-authored chat output не возвращается как steer.

### 13.3 Pi event mapping

- thinking не попадает в kind `9`;
- text delta попадает только в telemetry;
- complete visible text создаёт output intent;
- tool-only message не создаёт chat output;
- `agent_end{willRetry:true}` не завершает turn;
- `agent_settled` завершает;
- retry/compaction сохраняют active turn context.

### 13.4 Relay/reconnect

- NIP-42 challenge success/failure;
- stale/revoked NIP-OA fail-fast;
- reconnect повторяет auth и subscriptions;
- startup watermark закрывает blind spot;
- replay overlap не создаёт duplicate prompts;
- dynamic add/remove membership;
- lost publish `OK` повторяет тот же event ID;
- rate limiting не меняет order outbox.

### 13.5 Telemetry/Desktop compatibility

- golden `agent_message_chunk` fixture;
- `agent_thought_chunk` fixture;
- `tool_call`/`tool_call_update` correlation;
- `_goose/unstable/session/steer` содержит user/event metadata;
- `turn_started`/`turn_completed` lifecycle;
- payload/chunk size limits;
- NIP-44 recipient только owner;
- monotonically increasing seq per persisted session.

### 13.6 Security

- Nostr secret отсутствует в Pi tool env;
- second `auth` tag отклоняется;
- owner mismatch отклоняется;
- forged event и wrong-channel event отклоняются;
- unknown DM metadata fail-closed;
- untrusted message не может изменить output routing;
- telemetry plaintext не появляется в обычных logs.

### 13.7 Crash recovery

Fault injection после каждого шага:

- inbox insert;
- primary prompt acceptance;
- steer pending;
- steer delivery;
- Pi `message_end`;
- output intent insert;
- event signing;
- relay publish до/после `OK`;
- metric creation.

Проверки: нет потерянных accepted inputs, нет duplicate Nostr event IDs, нет reply на agent output.

---

## 14. MVP acceptance criteria

MVP считается готовым, когда:

1. Сервис запускается отдельно от Buzz repository и Buzz binaries.
2. Provisioning требует owner action только для NIP-OA attestation и channel membership.
3. Сервис самостоятельно публикует/восстанавливает kind `0`, presence и subscriptions.
4. Valid mentioned kind `9` запускает direct Pi `AgentSession`.
5. Same-thread kind `9` во время работы доставляется через `session.steer()`.
6. Different-thread event не steer'ит active turn.
7. Каждый завершённый visible assistant message публикуется отдельным kind `9`.
8. Все outputs активного turn отвечают первичному пользовательскому event, а не сообщениям агента.
9. Thinking и tools не попадают в chat, но видны в неизменённом Buzz Desktop через kind `24200`.
10. Usage публикуется encrypted kind `44200` без transcript content.
11. `cancel_turn`, reconnect, dedup, outbox retry и graceful shutdown работают.
12. Agent Nostr secret недоступен Pi tools.

---

## 15. Production parity после MVP

- несколько concurrent channels;
- configurable global/channel concurrency;
- lazy Pi session loading и eviction;
- full dynamic membership lifecycle;
- thread/DM history fetch через direct Nostr REQ;
- context size policy;
- telemetry backpressure без silent loss;
- model switching;
- owner controls;
- session rotation;
- dead-letter inspection/replay CLI;
- health/readiness endpoint;
- systemd/Docker deployment examples;
- long-running soak tests с relay outages.

---

## 16. Открытые вопросы

1. Оставлять ли legacy `pi-acp` binary рядом с новым `autogent-nostr` или заменить package entrypoint после MVP.
2. Финальное имя executable/package.
3. Нужна ли одна Pi session на channel или optional session-per-thread mode для очень шумных channels.
4. Максимальный допустимый размер одного chat message и политика oversized output: reject, truncate или deterministic split.
5. Какие Pi tools разрешены по умолчанию в автономном режиме.
6. Нужен ли отдельный signer broker уже в MVP или достаточно sealed store + sanitized child env.
7. Какой срок хранения local inbox/turn/outbox history.

Ни один из этих вопросов не требует изменений в Buzz repository.

---

## 17. Источники и совместимые contracts

Buzz reference, исследованный на commit `651f6372754e60e3f936b3397040eb0f1e44c9f3`:

- `crates/buzz-acp/src/lib.rs`
- `crates/buzz-acp/src/relay.rs`
- `crates/buzz-acp/src/pool.rs`
- `crates/buzz-acp/src/observer.rs`
- `crates/buzz-acp/src/config.rs`
- `crates/buzz-agent/`
- `docs/nips/NIP-AO.md`
- `docs/nips/NIP-AM.md`
- `docs/nips/NIP-OA.md`
- `desktop/src/features/agents/useAgentObserverIngestion.ts`
- `desktop/src/features/agents/observerRelayStore.ts`
- `desktop/src/features/agents/activeAgentTurnsStore.ts`
- `desktop/src/features/agents/ui/agentSessionTranscript.ts`

Pi SDK reference:

- `@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
- `@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.d.ts`
- `@earendil-works/pi-coding-agent/dist/core/agent-session-services.d.ts`
- `@earendil-works/pi-coding-agent/docs/sdk.md`
- `@earendil-works/pi-coding-agent/docs/session-format.md`

Критичные Pi API:

- `createAgentSessionRuntime()`;
- `AgentSession.prompt()`;
- `AgentSession.steer()`;
- `AgentSession.abort()`;
- `AgentSession.waitForIdle()`;
- `AgentSession.subscribe()`;
- `AgentSession.isStreaming` / `isIdle`;
- `SessionManager.create/open/list/forkFrom()`.
