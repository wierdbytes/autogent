# Autogent на удалённых нодах — план реализации

**Дата:** 2026-08-04
**Статус:** Design / implementation plan
**База:** [`20260803-standalone-nostr-agent.md`](20260803-standalone-nostr-agent.md) (autogent-nostr как headless-сервис)
**Нормативная спека:** `buzz/docs/remote-agents.md` (провайдер-протокол, remote lifecycle, k8s-биндинг)
**Изменения в Buzz:** не планируются (ни новых kinds, ни изменений релея, ни изменений Desktop)

---

## 0. Кратко

Цель — запускать `autogent-nostr` на удалённых нодах, управляя жизненным циклом из
Buzz Desktop через существующий провайдер-протокол `buzz-backend-<id>`, при этом:

- **никакого управляющего канала к ноде нет** — статус агента наблюдается по
  presence-событиям на релее, остановка выполняется `!shutdown`-сообщением по
  релею, срок жизни ограничивает сам harness (`exit-after-inactivity`);
- **relay-first bootstrap** — в substrate попадает только неустранимый
  bootstrap-минимум (`nsec`, `relay_url`, `auth_tag`); провайдерские
  credentials и конфигурация агента живут на релее как шифрованные
  NIP-AE-энграмы (kind `30174`) и читаются агентом при старте;
- функциональность релея (история, media, git, отправка сообщений) доступна
  модели через **кастомные тулы в harness-части** autogent-nostr.

```text
Owner-машина                              VM (k3s) / AKS              buzz relay
────────────                              ───────────────             ──────────
Buzz Desktop ──JSON/stdio──▶ buzz-backend-autogent-k8s
  │  (nsec в keyring,          │ kubectl-эквивалент (ambient kubeconfig)
  │   agent record,            ▼
  │   effective config)      Pod: autogent-nostr ◀──WS NIP-42──▶ relay
  │                            │  PVC: SQLite state + workspace
  └─ autogent auth ────────────┼─ подписывает engram'ы ключом агента ──▶ kind 30174:
     (OAuth flow, keyring)     │   (mem/provider-auth, core)               creds + config
                               └─ Pi SDK AgentSession + tools:
                                    NIP-50 search, Blossom, NIP-34 git,
                                    channel/thread send
```

---

## 1. Зафиксированные решения

Решения приняты в обсуждении 2026-08-04; здесь фиксируются как нормативные.

### 1.1 Архитектура: конформность `remote-agents.md`

Никакого собственного супервизора/desired-state-протокола. Роль супервизора
разобрана между уже существующими механизмами:

| Функция | Механизм |
|---|---|
| Запуск | провайдер-бинарь на машине owner'а, операция `deploy` |
| Статус | presence-события агента на релее (presence-is-status, I3) |
| Остановка | `!shutdown` по релею, owner-gated (уже реализовано в `src/security/control-commands.ts`) |
| Ограничение жизни | `exit-after-inactivity` в harness (I5) |
| Единственность инстанса | детерминированное имя Pod'а + generation-annotation (I4) |
| Рестарт при сбое | политика substrate (`restartPolicy`) |

Идея супервизора на ноде с desired-state через Nostr зафиксирована как
**возможное развитие** (см. §10), не как часть этого плана.

### 1.2 Substrate: k3s на VM, затем AKS

- Первый substrate — **k3s на Azure VM**. Провайдер работает через ambient
  kubeconfig (инвариант I2: cluster-креды никогда не в `provider_config`).
- Переезд в **AKS** — смена kubeconfig-контекста, без изменений кода.
- Один агент = один Pod (single container) + PVC (SQLite state + workspace).
  Никакого HPA/реплик: nostr-identity — синглтон, SQLite — один писатель.
- Storage class: k3s `local-path` (по умолчанию); в AKS — managed disk.

### 1.3 Провайдер: TypeScript, в этом репозитории

Новый бинарь **`buzz-backend-autogent-k8s`** рядом с существующим локальным
`buzz-backend-autogent`. Реализует провайдер-протокол `remote-agents.md`:
one process per operation, JSON запрос на stdin → JSON ответ на stdout,
exit code = один бит. Обязанности — §4.

### 1.4 Identity: генерирует Desktop, доставка только в deploy-payload

Существующий флоу buzz-desktop не меняется: nsec генерируется в
`create_managed_agent`, хранится в OS keyring (`agent:{pubkey}`), при деплое
достаётся из keyring и попадает в `deploy`-payload (`private_key_nsec`).
Fail-closed (I1): пустой ключ — refuse на этапе сборки payload.

На substrate nsec доезжает как **k8s Secret** — единственный секрет в
кластере (см. §3.1).

### 1.5 Провайдер-credentials: OAuth Max, 1 аккаунт = 1 агент, engram

- Тип: **Anthropic OAuth (подписка Max)**, с рефрешем и write-back.
- Жёсткое правило **1 OAuth-аккаунт = 1 агент**; `autogent auth` валидирует
  и отказывается привязывать один аккаунт ко второму агенту.
- Хранение — **только** NIP-AE engram `mem/provider-auth` (kind `30174`,
  NIP-44 conversation key agent↔owner). В deploy-payload, env и k8s
  credentials **не попадают** (§3.2).

### 1.6 Конфигурация агента: core-engram, динамически

Модель, систем-промпт, thinking/effort, respond_to-политика — в **core-engram**
NIP-AE (slug `core`; NIP определяет его как «agent identity, rules, goals»).

- Пишет Desktop/CLI **ключом агента из keyring** (легитимно: keyring владеет
  nsec по дизайну провайдер-протокола).
- Агент подписан на свой kind `30174` и применяет изменения **на лету**.
- Персона `30175` для доставки конфига **не используется**: непошаренная
  персона агенту не видна (гейт author-only-unless-shared, проверено по
  `buzz-db/src/event.rs`), пошаренная видна всему сообществу.
- Core-engram — **derived-артефакт** от effective config Desktop'а
  (слои baked → runtime → definition → global → persona → agent):
  переподписывается при каждом деплое и при каждом изменении записи агента
  через `autogent`-CLI. Источник правды остаётся на стороне owner'а;
  engram — его проекция для рантайма (§3.3).

### 1.7 Тулы релея в harness

Кастомные тулы поверх Pi SDK `AgentSession` (§5). Инвариант авто-ответов
сохраняется: видимый вывод модели по-прежнему публикуется автоматически и
модель не выбирает, куда идёт обычный ответ; тулы добавляют **дополнительные**
способы отправки (в другие каналы/треды) и чтения.

### 1.8 Образ и доставка

Контейнерный образ `autogent-nostr` собирается GitHub Actions, публикуется в
**ghcr.io**. Harness — PID-1 (или сигнальный таргет) контейнера; wrapper'ы
обязаны форвардить сигналы (§6.3).

### 1.9 Масштаб

Расчётный масштаб — 5–20 агентов. Решения, требующие оператора/CRD или
мультитенантных абстракций, сознательно не принимаются.

---

## 2. Nostr-контракты

Новых kinds нет. Используются существующие и уже узаконенные в релее
(релей fail-closed по kinds — это жёсткое ограничение):

| Kind | NIP | Использование в этом плане |
|---|---|---|
| `30174` | NIP-AE | engram'ы: `core` (конфиг), `mem/provider-auth` (креды). p-gated на релее; контент NIP-44 на conversation key agent↔owner |
| `30617`/`30618` | NIP-34 | git repository announcement / state — читаются git-тулом |
| `27235` | NIP-98 | HTTP-auth события для git Smart HTTP и Blossom |
| `9` + `#h` | NIP-29 | сообщения каналов: NIP-50 поиск, отправка тулами |
| `20001` и presence-схема buzz | — | presence-is-status (уже публикуется `PresencePublisher`) |
| `24200`/`44200` | — | телеметрия/usage (без изменений) |

Адресация engram'ов — по NIP-AE: `d = HMAC-SHA256(K_c, "agent-memory/v1/d-tag" ‖ 0x00 ‖ slug)`,
где `K_c` — NIP-44 conversation key. Слаги `core` и `mem/provider-auth`
удовлетворяют NIP-AE-грамматике. Слаг в тегах не появляется.

---

## 3. Relay-first bootstrap

### 3.1 Bootstrap-минимум (k8s Secret)

Единственный секрет в кластере — Secret с тройкой:

```
AUTOGENT_NSEC        # приватный ключ агента (bech32)
AUTOGENT_RELAY_URL   # wss://…
AUTOGENT_AUTH_TAG    # NIP-OA auth tag
```

Обоснование: без nsec нечем пройти NIP-42-auth и нечем расшифровать NIP-44 —
ключ принципиально не может «приехать по Nostr». Всё остальное — может, и
поэтому в Secret не попадает.

Схема Secret'а — по k8s-биндингу спеки: уникальное имя от pubkey+generation,
write-first, reference-exactly; GC по label-select.

Примечание: сейчас autogent-nostr держит sealed `identity.json` в state-dir и
не принимает ключ из env. Для контейнерного запуска добавляется явный
bootstrap-режим: при первом старте ключ из env материализуется в sealed
state (0600, PVC), env-переменная после этого игнорируется (state — источник
правды, как и сейчас). Tool-policy по-прежнему закрывает state-dir от
инструментов модели (`denyRoots`).

### 3.2 Провайдер-credentials через `mem/provider-auth`

**Запись (owner-сторона), `autogent auth`:**

1. `autogent auth login --agent <pubkey>` проводит OAuth-флоу Anthropic на
   машине owner'а.
2. Валидирует правило 1:1 — аккаунт не привязан к другому агенту (локальный
   реестр привязок).
3. Достаёт nsec агента из OS keyring (тот же keyring-сервис, что использует
   Desktop), строит engram `mem/provider-auth`:
   контент — NIP-44(conversation key) от JSON, эквивалентного
   `~/.pi/agent/auth.json` для данного провайдера;
   подпись — ключом **агента**.
4. Публикует на релей. Replaceable: остаётся только последняя версия.

**Чтение (агент, при старте):**

1. NIP-42-auth → fetch engram-головы `mem/provider-auth` (адрес вычислим:
   агент знает `K_c` и слаг).
2. Расшифровка → материализация pi-совместимого `auth.json` внутри state-dir
   (не в workspace; закрыто от тулов).
3. Нет головы → **fail-closed**: агент логирует причину, публикует presence
   с degraded-статусом и не принимает промпты (не стартует «пустым»).

**Write-back (агент, при рефреше):**

- pi SDK рефрешит OAuth-токен и перезаписывает локальный `auth.json`; harness
  перехватывает изменение (watcher на файл либо hook рантайма — уточняется
  при реализации, §11) и перепубликует `mem/provider-auth` — теперь уже
  собственной подписью агента (та же, что и у owner-версии: ключ один).
- Гонок нет по построению: писателей два (owner-CLI при re-auth, агент при
  рефреше), но оба используют один ключ и replaceable-адрес; правило 1:1
  исключает второго конкурирующего агента.
- При старте с PVC: если локальный `auth.json` новее engram-головы
  (`created_at`), выигрывает более свежий; агент немедленно публикует
  недостающую сторону. Это единственное правило слияния.

**Отзыв:** owner может в любой момент прочитать (симметричный `K_c`) и
перезаписать/удалить engram; следующий рефреш или рестарт агента упрётся в
недействительные креды → degraded, fail-closed.

### 3.3 Конфигурация через core-engram

Контент core-engram (NIP-44-шифрованный JSON), поля v1:

```jsonc
{
  "v": 1,
  "model": "anthropic/claude-…",        // → AUTOGENT_MODEL
  "thinking": "high",                    // → AUTOGENT_THINKING
  "system_prompt": "…",                  // → AUTOGENT_SYSTEM_PROMPT
  "respond_to": "owner-only|allowlist|anyone|nobody",
  "respond_to_allowlist": ["hex…"],
  "tools": { "include": [...], "exclude": [...] },   // + релейные тулы, §5
  "scheduler": { "max_concurrent_turns": 4, "context_message_limit": 12 },
  "inactivity_exit_sec": 7200            // 0 = бессрочно (легально)
}
```

- **Запись:** Desktop/CLI при деплое и при изменении agent record вычисляет
  effective config и переподписывает core-engram ключом агента из keyring.
  Провайдер `buzz-backend-autogent-k8s` делает это в рамках `deploy`
  (см. §4.3) — так engram гарантированно существует до старта Pod'а.
- **Чтение:** при старте — обязательная загрузка головы (fail-closed при
  отсутствии, как в §3.2); в рантайме — подписка на собственный kind `30174`
  и применение изменений на лету.
- **Горячее применение:** model/thinking/system_prompt — со следующего turn'а
  (новые `AgentSession` создаются с новыми параметрами; live-сессии каналов
  пересоздаются лениво); respond_to/allowlist и scheduler-лимиты — немедленно;
  `inactivity_exit_sec` — перезапуск таймера.
- **Прецедентность:** engram-голова **перекрывает** env. Env-эквиваленты
  (`AUTOGENT_MODEL` и т.д.) остаются только для локальной разработки и
  `up`-флоу; в контейнере они не задаются.
- Конфликт «persona 30175 vs engram»: не возникает, т.к. агент персону не
  читает, а engram переписывается из того же effective config, из которого
  Desktop запекал бы env. Инвариант: **после каждого изменения записи агента
  переподписать engram** — обязанность CLI/провайдера, зафиксирована тестом.

---

## 4. Провайдер `buzz-backend-autogent-k8s`

### 4.1 Контракт

По `remote-agents.md`: исполняемый файл `buzz-backend-autogent-k8s` в PATH
(discovery Desktop'ом по префиксу `buzz-backend-`), один процесс на операцию,
JSON на stdin/stdout, exit code — один бит; вывод провайдера трактуется
Desktop'ом как hostile (caps, redaction).

Операции:

- **`info`** — версия, схема `provider_config` (см. 4.2), capability-флаги.
- **`deploy`** — принять payload, привести substrate к состоянию
  «ровно один живой Pod агента нужного generation» (state machine спеки),
  вернуть `backend_agent_id`.
- Прочие операции контракта (наблюдение/удаление, если Desktop их шлёт) —
  реализуются по фактическому wire-контракту; **верификация точного набора
  операций по fixtures `buzz-backend-kubernetes/tests/fixtures/provider-wire/`
  — первый шаг реализации** (§11, О-1). Stop провайдер-операцией не является
  (это `!shutdown` по релею); delete живого агента требует
  `force_remote_delete` от UI.

### 4.2 `provider_config` (schema, без секретов)

```jsonc
{
  "kube_context": "k3s-agents",      // ambient kubeconfig, только имя контекста
  "namespace": "autogent",
  "image": "ghcr.io/wierdbytes/autogent:<tag>",
  "storage_class": "local-path",
  "storage_size": "2Gi",
  "inactivity_seconds": 7200          // 0 — легальное «бессрочно»
}
```

Flat, скаляры, ≤20 полей; ключи с `secret|password|token|key|credential` не
используются (валидатор Desktop'а всё равно их отвергнет).

### 4.3 Последовательность `deploy`

1. Прочитать payload; refuse при пустом `private_key_nsec` (I1).
2. Вычислить из nsec pubkey → детерминированные имена (Pod, Secret, PVC,
   labels, generation-annotation) по схеме k8s-биндинга.
3. **Подписать и опубликовать engram'ы** (nsec уже на руках):
   core-engram из полей payload (`system_prompt`, `model`, env-слоёв);
   `mem/provider-auth` — из локального хранилища `autogent auth`
   (refuse, если для агента нет привязанного аккаунта — деплоить агента без
   кредов бессмысленно, fail-closed до создания k8s-объектов).
4. Создать/обновить Secret (bootstrap-тройка) — write-first.
5. Создать/обновить PVC.
6. Convergence-петля по state machine спеки: если живёт Pod старого
   generation — дождаться/заменить с учётом at-most-one-live-instance (I4);
   создать Pod нужного generation со ссылкой на Secret и PVC.
7. Ответ: `{ok: true, backend_agent_id}`; ошибки — структурированные,
   redacted, fail-closed.

`env` payload'а (`launch.env`) в Pod **не переносится**: конфиг едет
engram'ом (§3.3). Провайдер переносит только не-секретные обвязочные
переменные (`AUTOGENT_RELAY_ID`, telemetry-флаги) — точный список
фиксируется при верификации wire-контракта (О-1).

### 4.4 Pod shape

- Один контейнер, `restartPolicy` по правилу спеки: bounded lifetime
  (`inactivity_seconds > 0`) → `Never`; indefinite → `OnFailure`.
- Harness — сигнальный процесс контейнера (`exec` в entrypoint).
- `terminationGracePeriodSeconds: 60`; shutdown-budget harness'а — §6.3.
- Resources: requests/limits (стартово: 256Mi/1Gi RAM, 100m/1000m CPU —
  уточняются по факту).
- Volumes: PVC → `/data` (`AUTOGENT_STATE_DIR=/data/state`,
  workspace `/data/workspace`); Secret → env.
- NetworkPolicy (отдельный манифест на namespace, вне провайдера): egress
  только relay + `api.anthropic.com`/`console.anthropic.com` + DNS.
- Liveness/readiness probes **не используются**: у harness нет HTTP-сервера,
  а presence-is-status делает k8s-пробы избыточными (позиция спеки —
  наблюдение через релей). Возможная позднейшая опция — exec-probe.

### 4.5 GC

Label-select по `app=autogent-agent` + два фильтра (annotation generation,
возраст по одному clock) — по схеме спеки: осиротевшие Secret/PVC/Pod
предыдущих generation'ов удаляются в рамках следующего `deploy`.

---

## 5. Тулы релея в harness

Все тулы регистрируются в Pi SDK `AgentSession` как кастомные; включение —
через `tools` в core-engram. Авторизация всех HTTP-вызовов — NIP-98
(kind `27235`) подписью ключа агента; membership и read-права проверяет релей
(fail-closed на его стороне).

### 5.1 `channel_history` / `channel_search`

- NIP-50: `{"search": q, "kinds": [9], "#h": [channel]}` историческим REQ
  (не persistent-подписка); relevance-sorted, лимит релея 500.
- Без поискового запроса — обычный REQ-фильтр по `#h` + `since/until/limit`
  (чтение хвоста истории).
- Доступ ограничен каналами-membership **релеем**; tool дополнительно
  валидирует, что `channel` ∈ известные membership'ы агента (ранний отказ,
  без утечки факта существования канала).
- История до появления агента в канале доступна в той мере, в какой её
  отдаёт релей, — локальная SQLite для поиска не используется (решение
  обсуждения: прямой поиск релея).

### 5.2 `media_get` / `media_put`

- Blossom: `PUT /upload` (BUD-02), `GET|HEAD /media/{sha256}.{ext}` (BUD-01),
  NIP-98-auth, SHA-256-binding (BUD-11).
- `media_put` принимает файл из workspace, возвращает hash-URL;
  `media_get` скачивает в workspace. Размер-лимиты тула — конфигурируемые,
  стартово 32 MiB.

### 5.3 git

- Протокол: NIP-34 (`30617`/`30618` — discovery репозиториев) + Smart HTTP
  релея (`/git/{owner}/{repo}/…`) с NIP-98-auth.
- Модель работает обычным `git` CLI через bash-тул; аутентификацию даёт
  **credential helper**, который получает подписанные NIP-98-токены от
  harness'а через локальный unix-socket. **Nsec не доступен ни helper'у как
  файлу, ни bash-окружению** — harness подписывает по запросу, helper только
  транспортирует токен. Socket живёт вне workspace; tool-policy запрещает
  чтение state-dir.
- Дополнительный тул `git_repos` (список/поиск announcement'ов kind `30617`)
  — для discovery без знания URL.
- Клоны — в `/data/workspace` (переживают рестарт Pod'а вместе с PVC).

### 5.4 `send_message`

- Публикация kind `9` в указанный канал (или reply в указанный тред).
- Ограничение: только каналы-membership; отправка проходит тот же durable
  outbox, что и авто-ответы (записал → подписал → опубликовал → подтвердил).
- Инвариант auto-reply не меняется: обычный видимый вывод модели публикуется
  как раньше, автоматически, в исходный тред; тул — для **дополнительных**
  сообщений (кросс-пост, уведомление в другой канал, новый тред).

---

## 6. Доработки autogent-nostr (harness)

### 6.1 Уже есть (переиспользуется без изменений)

- PresencePublisher: online/offline/heartbeat (`src/runtime/app-runtime.ts`).
- Owner-gated `!shutdown` / `!cancel` / `!rotate`
  (`src/security/control-commands.ts`).
- Graceful SIGTERM/SIGINT (`src/main.ts`), durable inbox/outbox/turns
  (SQLite WAL), crash recovery, tool sandbox
  (`readRoots`/`writeRoots`/`denyRoots`/`commandDenylist`).

### 6.2 Новое

1. **Bootstrap из env** (§3.1): материализация sealed identity из
   `AUTOGENT_NSEC` при первом старте.
2. **Engram-клиент**: вычисление `d`-тегов NIP-AE, fetch/decrypt голов,
   подписка на обновления, публикация write-back.
3. **Config-менеджер**: применение core-engram (§3.3), горячие обновления.
4. **Auth-материализация**: `mem/provider-auth` → pi `auth.json` в state-dir;
   watcher рефреша → write-back.
5. **`exit-after-inactivity`**: собственный таймер, независимый от состояния
   пула/сессий (урок спеки: reaper не должен зависеть от «проснулся ли
   pool»). «Inactivity» = нет dispatched-событий и нет turn'ов в полёте;
   сырой relay-трафик не считается. Срабатывание — через тот же graceful
   shutdown-путь, что `!shutdown` (drain → presence offline → close).
   `0` — легальное «бессрочно».
6. **Bounded shutdown tail**: единый дедлайн на весь post-signal путь
   ≤ grace-budget (60s) с **резервом на финализацию** (presence offline +
   relay close, ≥7s), который drain не может съесть; при исчерпании — drain
   деградирует первым.
7. **Тулы §5** и их конфигурационные ручки.
8. **Degraded-режим** (нет engram-голов / невалидные креды): агент онлайн
   для owner-диагностики (presence + control-commands), но промпты не
   принимает.

### 6.3 Контейнер

- `Dockerfile`: node ≥ 22.19, non-root user, `exec node dist/cli.js run` как
  PID-1 (или через tini с сигнал-форвардингом), `git` в образе (для §5.3).
- GitHub Actions: build → test → push `ghcr.io/wierdbytes/autogent`
  (теги: semver + sha).

---

## 7. `autogent auth` (CLI, owner-машина)

```
autogent auth login  --agent <pubkey>   # OAuth-флоу → keyring, публикация engram
autogent auth status [--agent <pubkey>] # какие агенты привязаны, срок токенов
autogent auth revoke --agent <pubkey>   # удалить привязку + перезаписать engram
```

- Хранилище привязок и токенов на owner-машине: OS keyring (тот же сервис,
  что у Desktop); файловый fallback 0600.
- Инвариант 1:1 аккаунт↔агент — проверка при `login`, refuse при попытке
  привязать занятый аккаунт.
- `login` немедленно публикует `mem/provider-auth` (nsec агента из keyring);
  `revoke` перезаписывает engram тумбстоуном.
- Deploy без привязки — refuse на шаге 3 провайдера (§4.3).

---

## 8. Security model

- **Секреты.** В k8s — только bootstrap-Secret (nsec). Провайдер-креды и
  конфиг — NIP-44-шифртексты на релее, p-gated kind `30174`; расшифровать
  могут ровно двое: агент и owner (симметричный conversation key — owner
  всегда может прочитать всё, это осознанное свойство NIP-AE).
- **Nsec в рантайме**: sealed state-dir (0600, PVC), `denyRoots` для тулов;
  NIP-98-подписи выдаёт harness через socket (§5.3) — ключ не появляется ни
  в env bash-тула, ни в файлах workspace.
- **Границы доверия** — по спеке: провайдер-бинарь получает nsec by design
  (это его работа); k8s-операторы кластера видят Secret (residual exposure
  k8s-биндинга, принимается); релей видит только шифртексты и метаданные.
- **Сеть**: egress-NetworkPolicy (relay, Anthropic API, DNS); ingress
  отсутствует — агент только dial-out.
- **Расход**: `max_concurrent_turns`, `max_turn_duration`,
  `inactivity_exit_sec` — потолки в core-engram; usage-телеметрия `44200`
  остаётся owner-доступной.
- **Fail-closed везде**: пустой ключ — refuse; нет engram — degraded; неизвестный
  kind — отклонит релей; чужой канал — отклонит релей + ранний отказ тула.

---

## 9. Implementation phases

**Phase R1 — harness bootstrap + engram'ы.**
env-bootstrap identity; engram-клиент; core-engram config-менеджер с горячим
применением; auth-материализация + write-back; degraded-режим.
*Милстоун:* контейнер локально (docker run) стартует из bootstrap-тройки,
читает конфиг и креды с dev-релея, отвечает в канал, переживает рефреш токена.

**Phase R2 — lifecycle-конформность.**
`exit-after-inactivity`; bounded shutdown tail с резервом финализации;
Dockerfile + CI → ghcr.io.
*Милстоун:* SIGTERM с 60s grace всегда успевает presence-offline; неактивный
агент самозавершается; образ публикуется по тегу.

**Phase R3 — провайдер.**
Верификация wire-контракта по fixtures (О-1); `buzz-backend-autogent-k8s`:
info/deploy, engram-публикация в deploy, Secret/PVC/Pod convergence, GC.
`autogent auth` CLI.
*Милстоун:* агент создаётся из Buzz Desktop GUI, деплоится на k3s-VM,
онлайн в Desktop по presence; `!shutdown` из Desktop останавливает Pod;
redeploy обновляет generation без второго живого инстанса.

**Phase R4 — тулы релея.**
`channel_history`/`channel_search`; `media_get`/`media_put`;
git credential-socket + `git_repos`; `send_message` через outbox.
*Милстоун:* модель из удалённого Pod'а ищет по истории канала, читает и
публикует media, клонирует/пушит репозиторий релея, отправляет сообщение в
другой канал-membership.

**Phase R5 — эксплуатация.**
k3s на Azure VM (bootstrap-скрипт/доки), NetworkPolicy, namespace,
runbook (упавший Pod, протухшие креды, потеря PVC, переезд в AKS).
*Милстоун:* 2+ агента живут на VM ≥ недели без ручных вмешательств;
документированный переезд одного агента в AKS.

---

## 10. Возможное развитие (вне плана)

- Супервизор на ноде с desired-state через Nostr (снимает необходимость
  kubeconfig на owner-машине; отвергнут для v1 в пользу конформности спеке).
- Docker-биндинг без k8s (`buzz-backend-autogent-docker`).
- Exec-probes / метрики Prometheus в дополнение к presence.
- Каталожная (shared) персона `30175` как публичная витрина агента —
  независимо от конфиг-канала.

## 11. Открытые вопросы (верифицируются в начале реализации)

- **О-1.** Точный wire-контракт провайдера: полный набор операций и полей —
  по fixtures `buzz/crates/buzz-backend-kubernetes/tests/fixtures/provider-wire/`
  и §Provider Protocol. Блокирует Phase R3.
- **О-2.** Как Desktop реагирует на провайдера, игнорирующего `launch.env`
  (наш конфиг едет engram'ом): достаточно ли `info`-capabilities или
  требуется зеркалить env в Pod для совместимости.
- **О-3.** Механизм перехвата OAuth-рефреша в pi SDK: file-watcher на
  `auth.json` vs хук рантайма (что даёт SDK).
- **О-4.** Формат тела `auth.json`-эквивалента в engram: один провайдер или
  сразу мультипровайдерная структура (как у pi).
- **О-5.** Retention релея для kind `30174`: подтвердить, что replaceable-головы
  не выпадают по возрасту (иначе рестарт старого агента осиротеет).

## 12. Acceptance criteria (MVP remote)

1. Агент, созданный в Buzz Desktop с провайдером `autogent-k8s`, оказывается
   онлайн на k3s-VM; в k8s нет ни одного секрета, кроме bootstrap-тройки.
2. Изменение модели/промпта на owner-стороне доезжает до работающего агента
   без redeploy (core-engram, следующий turn — с новым конфигом).
3. OAuth-рефреш переживает пересоздание Pod'а с чистым PVC (креды
   восстанавливаются из engram-головы).
4. `!shutdown` из Desktop: graceful drain, presence offline, Pod завершён;
   неактивный агент с `inactivity_seconds=7200` завершается сам.
5. Все четыре тула §5 работают из удалённого Pod'а; попытка доступа к
   не-membership каналу отклоняется.
6. Redeploy новой версии образа не порождает второго живого инстанса
   (at-most-one, generation).
