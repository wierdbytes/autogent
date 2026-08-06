# Langfuse tracing — план интеграции

**Дата:** 2026-08-06
**Статус:** Design / implementation plan
**Область:** `autogent-nostr` runtime, config record schema, owner-side CLI

---

## 0. Кратко

Агент получает опциональную отправку трейсов в Langfuse (cloud или self-hosted) для
последующего анализа: один trace на turn, generation-observations с usage/cost на каждый
вызов модели, span на каждый tool call, Nostr-метаданные (канал, автор, relay) для
фильтрации и группировки. Опция включается владельцем при создании/настройке профиля
агента и доезжает до runtime тем же путём, что и остальной конфиг: env для локального
режима, `autogent/config` record (kind 30078) для remote.

```text
channel-actor ──PiEvent──▶ TracingPort (LangfusePublisher)
                              │  capture policy + redaction
                              ▼
                    @langfuse/tracing + LangfuseSpanProcessor
                              │  batched OTel export
                              ▼
                     Langfuse (cloud / self-hosted)
```

Реализация — собственная, поверх уже существующего нормализованного `PiEvent`-потока.

---

## 1. Решение и отклонённые альтернативы

### 1.1 Принято: собственный `LangfusePublisher`

Публикатор-адаптер в `src/telemetry/`, сосед `ObserverPublisher` и `UsagePublisher`,
подключаемый к turn-циклу `ChannelActor` через новый узкий порт (§4). Причины:

- **Nostr-метаданные обязательны** (требование): channel id, npub автора, relay,
  conversation key должны попадать в trace как `sessionId`/`userId`/`metadata`.
  Готовые pi-extensions этого контекста не видят — он живёт в runtime autogent.
- **Privacy — часть профиля агента** (требование): preset выбирается владельцем при
  создании профиля и едет через config record. Это конфиг-плоскость autogent, а не
  файл `~/.pi/agent/.../config.json` стороннего расширения.
- Runtime уже владеет нормализованным закрытым множеством `PiEvent`
  (`runtime/ports.ts:456+`) с usage и costUsd в `message_end` — сырья достаточно,
  провайдер-специфичных хуков не нужно.
- Полный контроль над shutdown-бюджетом (`lifecycle.shutdownBudgetSec`), fail-safe
  поведением и объёмом зависимостей.

### 1.2 Отклонено: `pi-langfuse` (npm) через `pi.extensions`

Проверено: peer dep — ровно `@earendil-works/pi-coding-agent`, headless-режим работает
от `LANGFUSE_*` env, мультисессионность есть. Подключился бы одной строкой
`AUTOGENT_EXTENSIONS=npm:pi-langfuse`. Отклонён, потому что:

- не видит Nostr-контекст (trace группируется только по pi session, metadata-механизм
  заточен под git-репозитории);
- privacy настраивается его собственным конфигом/env, а не профилем агента;
- дублировал бы существующую телеметрию событий (свой слой поверх тех же событий SDK),
  при этом контроль версий и поведения — у стороннего мейнтейнера.

Что из него заимствуем как референс: модель trace (root agent → generations → tools),
capture-presets, шейпинг payload, идею trace-level scores.

### 1.3 Отклонено: переиспользование `TelemetryPort`

`TelemetryPort.emit()` принимает ACP-shaped `ObserverFrameDraft` — lossy
wire-представление для Buzz Desktop. Восстанавливать из него семантику turn'а хуже,
чем подписаться на исходные `PiEvent`. Langfuse-публикатор получает свой порт (§4).

---

## 2. Зависимости и транспорт

SDK v3 (`langfuse` npm) deprecated; актуальная линейка — v5 (`@langfuse/*`, OTel-based).

Берём минимальный набор, **без** `@opentelemetry/sdk-node`:

```
@langfuse/tracing   — startObservation() c явным parent и timestamps
@langfuse/otel      — LangfuseSpanProcessor (batching, flush, auth)
@langfuse/client    — scores API (опционально, этап 5)
@opentelemetry/api
@opentelemetry/sdk-trace-base — свой TracerProvider, изолированный от глобального
```

Публикатор создаёт собственный `TracerProvider` c одним `LangfuseSpanProcessor` и не
регистрирует его глобально: autogent не OTel-приложение, глобальный контекст нам не
нужен и не должен утекать в pi SDK. Все spans создаются вручную с явным parent и явным
`startTime`/`endTime` из событий (`clock.now()`), а не из ambient context.

Self-hosted Langfuse поддерживается из коробки (`baseUrl`).

---

## 3. Модель трейса

| Langfuse | autogent | Примечание |
| --- | --- | --- |
| `sessionId` | conversation key (`runtime/conversation-key.ts`) | Канал = разговор; переживает `rotate()` pi-сессии |
| trace | один turn (`TurnContext.turnId`) | Детеминированный trace id из turnId |
| `userId` | npub автора триггерящего события | `nip19.npubEncode` |
| root span `agent` | turn: prompt → settle | input: сформированный prompt, output: финальный текст ассистента |
| `generation` | каждый `message_end` c `role === "assistant"` | model из `session.model`; usage/cost из `PiUsage` |
| span `tool` | пары `tool_start`/`tool_end` по `toolCallId` | `isError` → `level: ERROR` |
| event | `retry`, `compaction`, steering-ввод | |
| `environment` | из конфига (`local` / `remote`) | |
| tags | `channelType`, relayId | |

`metadata` root-спана (всегда, при любом privacy preset — это и есть «Nostr-метаданные»):

```json
{
  "relay_id": "default",
  "channel_id": "<id>",
  "channel_type": "stream",
  "channel_name": "<name|null>",
  "author_npub": "npub1...",
  "triggering_event_ids": ["..."],
  "pi_session_id": "<uuid>",
  "turn_id": "<uuid>",
  "model": "anthropic/claude-...",
  "stop_reason": "end_turn"
}
```

Usage маппится: `input/output/cacheRead/cacheWrite` → `usageDetails`,
`costUsd` → `costDetails.total`.

Незакрытые observations при abort/idle-timeout/shutdown закрываются с
`metadata: { completed: false }` и статусом причины (паттерн `handleSessionInterruption`
из pi-langfuse).

---

## 4. Точка врезки: порт `TracingPort`

Новый порт в `runtime/ports.ts`, сосед `TelemetryPort`:

```ts
export interface TracingPort {
  /** Turn начат: identity + вход. Никогда не бросает. */
  turnStarted(route: TelemetryTurnRoute, info: TracingTurnInfo): void;
  /** Нормализованное событие Pi внутри turn'а. */
  event(turnId: string, event: PiEvent): void;
  /** Steering-ввод, доставленный в running turn. */
  steering(turnId: string, text: string, authorPubkey: string): void;
  /** Turn завершён; закрывает trace. */
  turnFinished(turnId: string, outcome: { stopReason: string; finalText: string | null }): void;
  /** Дожать очередь; вызывается на settle и в shutdown. */
  flush(): Promise<void>;
  shutdown(budgetMs: number): Promise<void>;
}

export interface TracingTurnInfo {
  channelType: ChannelType;
  channelName: string | null;
  authorPubkey: string;
  triggeringEventIds: string[];
  prompt: string;
  /**
   * Полный эффективный систем-промпт сессии на момент старта turn'а.
   * Источник — публичный геттер SDK `AgentSession.systemPrompt`
   * («includes any per-turn extension modifications»), проброшенный через
   * новое поле `AgentSessionHandle.systemPrompt`. Передаётся всегда;
   * отправляется только при preset `full` (§6).
   */
  systemPrompt: string | undefined;
  model: string | undefined;
}
```

Врезка в `ChannelActor` — рядом с существующими вызовами `telemetry`:

- `#beginTurn` (рядом с `telemetry.emit({kind:"turn_started"})`, channel-actor.ts:291) →
  `tracing.turnStarted(...)`;
- обработчик подписки (`#subscribeToSession`, там где `mapPiEvent`, :406) →
  `tracing.event(turnId, event)` — сырое `PiEvent` до ACP-трансляции;
- steering-доставка (:376) → `tracing.steering(...)`;
- `#settleTurn` (рядом с `turn_completed`/`turn_error`, :476) →
  `tracing.turnFinished(...)`.

Дефолтная реализация — `NoopTracingPort`; `LangfusePublisher` подставляется в
`app-runtime.ts` только когда опция включена и credentials resolved. Actor о Langfuse
не знает ничего.

---

## 5. Конфигурация

### 5.1 `AgentConfig` (без секретов — инвариант config.ts сохраняется)

```ts
export type LangfusePrivacyPreset = "metadata-only" | "conversations" | "full";

export interface LangfuseConfig {
  enabled: boolean;                 // default false
  host: string;                     // default https://cloud.langfuse.com
  privacy: LangfusePrivacyPreset;   // default "conversations"
  sampleRate: number;               // 0..1, default 1
  environment?: string;             // default: remote.recordConfig ? "remote" : "local"
}

export interface TelemetryConfig {
  enabled: boolean;
  coalesceMs: number;
  metricsEnabled: boolean;
  langfuse: LangfuseConfig;         // ← новое
}
```

Env overlay (`applyEnv`):

```
AUTOGENT_LANGFUSE            → langfuse.enabled (bool)
AUTOGENT_LANGFUSE_HOST       → langfuse.host
AUTOGENT_LANGFUSE_PRIVACY    → langfuse.privacy (enum, typo → base value)
AUTOGENT_LANGFUSE_SAMPLE     → langfuse.sampleRate
AUTOGENT_LANGFUSE_ENV        → langfuse.environment
```

`validateConfig`: `enabled && sampleRate ∉ [0,1]` → problem; `privacy` вне enum —
недостижимо (enum-фильтр в overlay).

### 5.2 Credentials — отдельно от `AgentConfig`

`publicKey`/`secretKey` не попадают в конфиг-объект и логи. Резолвер
`resolveLangfuseCredentials()` (в `runtime/provider-auth.ts` по соседству с pi auth):

1. **Локальный режим:** стандартные `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
   (совместимо с экосистемой Langfuse).
2. **Remote (record-config):** новый record `autogent/langfuse` (kind 30078,
   инфраструктура слугов уже допускает — `isValidSlug`), body:

   ```json
   { "slug": "autogent/langfuse", "value": { "public_key": "pk-lf-...", "secret_key": "sk-lf-..." } }
   ```

   `value: null` — tombstone (ключи отозваны → tracing выключается на лету).
   Секреты на wire NIP-44-шифрованы под self-key, как и `autogent/auth`.
   В `autogent/auth` не кладём: тот материализуется как pi `auth.json` as-is,
   чужие ключи в файле pi недопустимы.

Fail-closed-degraded: `enabled: true` без credentials → один warn в лог,
`NoopTracingPort`, агент работает дальше.

### 5.3 `CoreConfigV1` (профиль агента, remote plan §3.3)

Владелец задаёт опцию при создании/редактировании профиля; Desktop/CLI публикует её в
`autogent/config`:

```ts
langfuse?: {
  enabled?: boolean;
  host?: string;
  privacy?: "metadata-only" | "conversations" | "full";
  sample_rate?: number;
  environment?: string;
};
```

- `parseCoreConfig`: строгая валидация блока (enum, диапазон), structural problem →
  reject всего документа (существующая семантика).
- `applyCoreConfig`: overlay на `telemetry.langfuse` (record > env).
- Hot-reload: `app-runtime #onCoreRecord` уже переконфигурирует на лету; publisher
  поддерживает `reconfigure()` — смена privacy/sample без рестарта, смена
  enabled/host/credentials — flush + пересоздание процессора.
- Owner-side: `config publish` валидирует блок через тот же `parseCoreConfig`
  (уже так работает); для ключей — новые команды
  `langfuse set --agent <pk>` / `langfuse revoke --agent <pk>` в `owner-auth/`,
  по образцу `auth login/revoke`.

---

## 6. Privacy и redaction

Preset выбирается владельцем при создании профиля (§5.3). Enforcement — в публикаторе,
модуль `telemetry/langfuse-capture.ts`:

| Поле | `metadata-only` | `conversations` | `full` |
| --- | :-: | :-: | :-: |
| Nostr-метаданные, usage, cost, тайминги, tool-имена, error-флаги | ✅ | ✅ | ✅ |
| prompt (input) и текст ответа (output) | — | ✅ | ✅ |
| thinking, tool input/output | — | — | ✅ |
| систем-промпт (полный эффективный) | — | — | ✅ |

Систем-промпт берётся из геттера SDK `AgentSession.systemPrompt` — это полный
эффективный промпт (базовый промпт Pi + tool guidelines + `appendSystemPrompt` +
per-turn модификации extensions), а не только дописка из конфига. Читается в
`#beginTurn` через новое поле `AgentSessionHandle.systemPrompt` (расширение адаптера
в `session-registry.ts`; расширять `PiEvent`/router не требуется). Кладётся в
`metadata.system_prompt` root-спана только при preset `full`, проходит redaction и
шейпинг наравне с остальным контентом; при неизменном значении внутри одной
pi-сессии повторно не отправляется — вместо тела кладётся хеш-ссылка
(`system_prompt_ref: sha256(...)`) на последнюю полную копию, чтобы не раздувать
каждый trace многокилобайтным дублем.

Default — `conversations`: агент читает чужие сообщения из каналов, tool I/O может
содержать содержимое файлов и вывод команд — это самый рискованный слой.

Redaction (применяется до отправки при любом preset, где контент вообще есть):

- маскирование известных паттернов секретов (bearer/api-keys, `sk-`/`pk-`-префиксы,
  nsec, приватные ключи PEM) — простой список регэкспов, без claims на полноту;
- шейпинг: строки > 16 KB усекаются с маркером, tool payload > 24 KB усекается;
  бюджеты — константы модуля, не конфиг (меньше поверхностей).

Инвариант: nsec агента и содержимое `auth.json` не проходят через `PiEvent`-поток,
но redaction всё равно прогоняется — defense in depth.

---

## 7. Отказоустойчивость и lifecycle

- **Никогда не мешаем turn'у:** все методы порта синхронно кладут работу в очередь и
  не бросают (паттерн `TelemetryPort.emit`). Ошибки экспорта — warn с rate-limit,
  счётчик drop'ов в лог на settle.
- **Backpressure:** очередь span-операций ограничена (например, 5000 узлов);
  переполнение — drop новых с одним warn. `LangfuseSpanProcessor` батчит сам.
- **Sampling:** решение на границе turn'а (`turnStarted`): unsampled turn → все
  последующие события этого turnId игнорируются. Детерминированно от turnId, чтобы
  ретраи не меняли решение.
- **Shutdown:** `app-runtime` вызывает `tracing.shutdown(budget)` внутри
  `lifecycle.shutdownBudgetSec`, с собственным ceil ≤ 5 s; не успели — дропаем,
  выход не задерживаем (k8s grace budget важнее хвоста трейсов).
- **Idle-timeout / abort / rotate:** `turnFinished` со stopReason закрывает
  observations как cancelled (§3).

---

## 8. Тестирование

- Unit: capture policy (3 preset × поля), redaction-регэкспы, маппинг
  `PiEvent → observations` (fake exporter: `InMemorySpanExporter` из
  `sdk-trace-base`), sampling-детерминизм.
- Unit: `parseCoreConfig`/`applyCoreConfig` для блока `langfuse`, env overlay,
  резолвер credentials (env / record / tombstone).
- Actor-level: существующие тесты `ChannelActor` с `NoopTracingPort`; один сценарий
  с recording-фейком порта — порядок turnStarted → events → turnFinished, закрытие
  при abort.
- Ручная проверка: локальный агент → Langfuse cloud, проверить trace, generation
  usage/cost, tool spans, метаданные, оба «урезанных» preset'а.

---

## 9. Этапы

1. **Config-плоскость:** `LangfuseConfig` в `config.ts`, env overlay, validate,
   `CoreConfigV1.langfuse` + parse/apply, резолвер credentials (env-часть).
2. **Порт и wiring:** `TracingPort` + `NoopTracingPort` в `ports.ts`, четыре врезки в
   `channel-actor.ts`, `systemPrompt` на `AgentSessionHandle` (адаптер в
   `session-registry.ts` + тестовые фейки), прокидка через `app-runtime.ts`.
   Всё под no-op — поведение агента не меняется.
3. **Publisher:** `telemetry/langfuse-publisher.ts` (+`langfuse-capture.ts`):
   TracerProvider + LangfuseSpanProcessor, модель трейса §3, privacy §6, sampling,
   shutdown-бюджет. Unit-тесты на fake exporter.
4. **Remote:** record `autogent/langfuse`, tombstone-семантика, hot-reload через
   `#onCoreRecord`, owner-side `langfuse set/revoke`, обновить `docs/runbook-remote.md`.
5. **(Опционально) Scores:** trace-level scores (tool error rate, stopReason ok/err)
   через `@langfuse/client` — отдельным этапом, после обкатки основного потока.

Этапы 1–3 самодостаточны для локального режима; 4 — для k8s/Desktop-профилей.
