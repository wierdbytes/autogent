# buzz CLI вместо кастомных relay-тулзов — план реализации

**Дата:** 2026-08-05
**Статус:** Implemented (PR-1…PR-3 одной серией; `buzz_cli.enabled` default **true**,
т.к. кастомные тулзы удалены сразу; пин `BUZZ_REV=014562c063ea`; промпт живёт
в `src/prompts/buzz-cli.ts` — tsc не копирует .md в dist; шим — `scripts/buzz-shim.cjs`,
репо имеет `"type": "module"`)
**База:** [`20260804-remote-nodes.md`](20260804-remote-nodes.md) (текущая архитектура рантайма и тулзов)
**Изменения в Buzz:** не планируются — buzz используется только как read-only
источник исходников `buzz-cli` (публичный `github.com/block/buzz`, пин по SHA)

---

## 0. Кратко

Цель — заменить семь кастомных relay-тулзов (`channel_list`, `channel_history`,
`channel_search`, `send_message`, `media_get`, `media_put`, `git_repos`) на
CLI-утилиту `buzz` по образцу buzz-acp: бинарь кладётся в Docker-образ, агент
получает в системный промпт краткую справку по возможностям утилиты и дальше
раскрывает их сам через `buzz --help` / `buzz <group> --help`.

Ключевое отличие от buzz-acp: autogent **намеренно не пускает секреты в
bash-окружение агента** (`src/security/secret-vault.ts` вычищает `BUZZ_*`,
`*KEY*`, `AUTH*` из env дочерних процессов), а `buzz` CLI требует
`BUZZ_PRIVATE_KEY` в env или `--private-key`
(`buzz/crates/buzz-cli/src/lib.rs:71-90, 1940`) и других способов авторизации
не имеет. Поэтому CLI запускается **не напрямую из bash**, а через
shim-обёртку: ключ инжектит родительский процесс autogent.

Принятые решения:

- **Доставка ключа:** shim через unix-сокет (ключ никогда не попадает в bash env).
- **Судьба тулзов:** полная замена — все 7 кастомных тулзов удаляются.
- **Бинарь:** собирается в build-stage Dockerfile autogent из пина buzz-репо
  (внешних артефактов/CI buzz не требуется).

## 1. Целевая архитектура

```text
Pi-сессия (bash-тул)
  └─▶ /usr/local/bin/buzz            (shim, ~50 строк node)
        │  unix socket: $TMPDIR/autogent-buzz.sock
        ▼
      BuzzCliBroker                   (в процессе autogent; ключ в памяти)
        │  spawn /opt/buzz/buzz-real
        │  env: BUZZ_RELAY_URL, BUZZ_PRIVATE_KEY, BUZZ_AUTH_TAG
        ▼
      buzz-cli ──HTTP(S) + NIP-98──▶ relay
```

Что **остаётся** без изменений:

| Компонент | Почему остаётся |
|---|---|
| Автопубликация основного ответа + durable outbox | Это output router, а не тул; на его формате держатся транскрипты Buzz Desktop (`src/runtime/prompt-formatter.ts:90` — «Do not attempt to send it yourself») |
| `GitAuthProxy` (`src/tools/git-tools.ts`) | git у агента ключа не имеет: `git-credential-nostr` из buzz требует `NOSTR_PRIVATE_KEY`/keyfile — обе опции ломают shim-модель. Прокси остаётся как инфраструктура (не model-visible тул) |
| `RelayPort` / `Signer` / event loop | Рантайм сам слушает события, публикует ответы, читает config record |

## 2. Бинарь: build-stage в Dockerfile

`buzz-cli` собирается из workspace buzz командой `cargo build --release -p
buzz-cli`, имя бинаря — `buzz` (`crates/buzz-cli/Cargo.toml: [[bin]] name =
"buzz"`).

```dockerfile
# --- этап 1: buzz-cli (пиним коммит buzz) ---
ARG BUZZ_REV=<commit-sha>
FROM rust:1-slim-bookworm AS buzz-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
      git pkg-config libssl-dev ca-certificates
WORKDIR /src
RUN git init . \
 && git remote add origin https://github.com/block/buzz \
 && git fetch --depth 1 origin ${BUZZ_REV} \
 && git checkout FETCH_HEAD
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p buzz-cli \
 && cp target/release/buzz /buzz-real

# --- runtime stage (существующий node:22-slim) ---
COPY --from=buzz-cli /buzz-real /opt/buzz/buzz-real
COPY scripts/buzz-shim.js /usr/local/bin/buzz
```

- База builder'а `rust:1-slim-bookworm` — тот же Debian, что у `node:22-slim`,
  динамическая линковка glibc работает, musl не нужен.
- Пин по SHA через `ARG BUZZ_REV`: версия CLI полностью под контролем
  autogent; обновление = bump одной строки + CI. Это же закрывает вопрос
  дрейфа CLI↔релей.
- BuildKit cache-mounts на cargo registry/target; холодная сборка — только при
  bump'е `BUZZ_REV`.
- Настоящий бинарь лежит **вне PATH** (`/opt/buzz/buzz-real`); в PATH — shim.
- `git-credential-nostr`-personality multicall-бинаря не symlink'ается: git-auth
  остаётся на `GitAuthProxy`.

## 3. BuzzCliBroker (новый `src/tools/buzz-broker.ts`)

Создаётся в `AppRuntime` рядом с `GitAuthProxy` (`src/runtime/app-runtime.ts`),
закрывается на shutdown.

- **Socket:** `$TMPDIR/autogent-buzz.sock`. `TMPDIR` уже в
  `CHILD_ENV_ALLOWLIST` (`src/security/secret-vault.ts:19-39`) — новых
  env-переменных и правок allowlist не нужно; путь захардкожен в shim
  (fallback `/tmp`).
- **Протокол** (без стриминга, не переусложняем): одна JSON-строка запрос
  `{argv: string[], cwd: string, stdin: string | null}` → одна JSON-строка
  ответ `{stdout: string, stderr: string, exitCode: number}`. Поддержка stdin
  обязательна — базовый промпт учит паттерну
  `printf '...' | buzz messages send --content -`.
- **Env спавна CLI:** `BUZZ_RELAY_URL` = `httpOrigin` (уже вычисляется,
  `httpOriginOf` в `src/tools/deps.ts`), `BUZZ_PRIVATE_KEY` = hex ключа,
  `BUZZ_AUTH_TAG` = JSON auth-тега из identity, минимальные `PATH`/`HOME`.
- **Argv-guards:** отклонять `--private-key`, `--auth-tag`, `--relay`/
  `--relay-url` — авторизация и адрес релея задаются только брокером.
  Дополнительно: настраиваемый denylist сабкоманд из config record
  (`buzz_cli.deny_commands`).
- **Лимиты:** переиспользовать константы tool-policy
  (`src/security/tool-policy.ts`) — timeout 120s, вывод ≤64KB с пометкой об
  обрезке. Ограничение параллелизма (например, 4 одновременных CLI-процесса).
- **Git clone-URL rewrite (bidirectional, ~15 строк):**
  - stdout `buzz repos list/get`: clone-URL релея (`httpOrigin/git/...`) →
    loopback-адрес `GitAuthProxy`;
  - argv (например `buzz pr open --clone ...`): loopback-адрес → URL релея,
    чтобы localhost не утёк в публичные события.
- **Ключ:** `src/provisioning/identity-store.ts` начинает отдавать secret hex
  рантайму (сейчас байты уходят только в `createSigner`); брокер держит его в
  замыкании, в `process.env` autogent не кладёт.

**Остаточный риск (принят, документируется):** агент теоретически может
прочитать `/proc/<pid>/environ` живого CLI-процесса (один uid в контейнере);
окно — длительность одной команды. Митигация потребовала бы изменений CLI
(ключ через stdin/fd), что вне рамок autogent.

## 4. Shim `/usr/local/bin/buzz` (новый `scripts/buzz-shim.js`)

Node-скрипт (node уже в образе): собрать `argv`+`cwd`+stdin → отправить в
сокет → напечатать `stdout`/`stderr`, выйти с `exitCode`. Если сокет
недоступен — понятная ошибка «buzz недоступен в этой среде» и exit 4.

## 5. Промпт

- Новый **`src/prompts/buzz-cli.md`** — усечённый аналог
  `buzz/crates/buzz-acp/src/base_prompt.md`:
  - таблица групп команд: `messages`, `channels`, `canvas`, `reactions`,
    `dms`, `users`, `feed`, `repos`/`issues`/`pr`, `upload`;
  - exit-коды (0 ok / 1 user / 2 network / 3 auth / 4 other), JSON-вывод;
  - «`buzz <group> --help` для полной справки» — самораскрытие возможностей;
  - stdin-паттерн для multiline (`--content -`), правила `--mention` и
    `--reply-to`;
  - `buzz://` deep-links из полей `link` — включать в сообщения verbatim.
- **Обязательные отличия от buzz-acp:**
  1. «Auth уже настроен харнессом; env-переменные ключей тебе не видны и не
     нужны» (иначе модель будет искать `BUZZ_PRIVATE_KEY`).
  2. Модель ответа autogent сохраняется: «основной ответ публикуется
     автоматически; `buzz messages send` — только для кросс-постов, новых
     тредов и сообщений в другие каналы» (иначе double-posting).
- **Инжект:** композиция builtin-промпта с `config.pi.appendSystemPrompt` в
  `src/runtime/session-registry.ts:155-165` — `DefaultResourceLoader`
  принимает массив: `[buzzCliPrompt, ...(config.appendSystemPrompt ?? [])]`.
- **`src/runtime/prompt-formatter.ts`**, секция `[Context]`: добавить
  подсказки в стиле buzz-acp с подставленным UUID канала —
  `buzz messages thread --channel <UUID> --event <ID>` для тредов,
  `buzz messages get --channel <UUID>` для истории. Существующая строка про
  автопубликацию ответа остаётся.

## 6. Удаление кастомных тулзов

Удаляются:

- `src/tools/channel-tools.ts`, `src/tools/media-tools.ts`,
  `src/tools/send-message-tool.ts`;
- из `src/tools/git-tools.ts` — model-visible тул `gitReposTool` (класс
  `GitAuthProxy` остаётся);
- `RELAY_TOOL_NAMES` и `buildRelayTools()` в `src/tools/index.ts` — заменить
  на конструктор брокера + экспорт `GitAuthProxy`;
- wiring `customTools`: `src/runtime/session-registry.ts:173`,
  `src/runtime/app-runtime.ts:154-175` (включая `sendChat`-deps, если больше
  никем не используется — проверить output router).

`RelayToolDeps` (`src/tools/deps.ts`) сжимается до нужд брокера и прокси
(`httpOrigin`, `builder`, `clock`, `logger`).

## 7. Конфиг

`src/runtime/remote-config.ts` (config record kind 30078), новая секция:

```json
{ "buzz_cli": { "enabled": true, "deny_commands": ["agents"] } }
```

- `enabled` — фича-флаг поэтапного выката (PR-1 ставит default `false`);
- `deny_commands` — префиксный denylist argv (группа или `группа подкоманда`);
- hot-apply как остальной config record (`app-runtime.ts #onCoreRecord`).

`tools.include/exclude` продолжают управлять встроенными Pi-тулзами (bash и
пр.); кастомных имён в них больше нет.

## 8. Тесты

Новые:

- broker unit: fake-бинарь (bash-скрипт вместо `buzz-real`) — проверка
  env-инжекта, argv-guards, stdin-форвардинга, обрезки вывода, timeout,
  ограничения параллелизма, URL-rewrite в обе стороны;
- shim↔broker интеграция через реальный unix-сокет;
- snapshot `buzz-cli.md`-промпта и `[Context]`-хинтов;
- `remote-config`: парсинг/hot-apply секции `buzz_cli`.

Изменения:

- `test/tools.test.ts` — снести всё, кроме тестов `GitAuthProxy`/NIP-98;
- `test/remote-config.test.ts` — дополнить `buzz_cli`.

## 9. Поэтапность

1. **PR-1** — Dockerfile build-stage (`BUZZ_REV`), `BuzzCliBroker`, shim;
   всё за флагом `buzz_cli.enabled=false`, старые тулзы нетронуты. Катится
   без риска.
2. **PR-2** — `src/prompts/buzz-cli.md`, композиция appendSystemPrompt,
   `[Context]`-хинты; включение флага в тестовом окружении.
3. **PR-3** — удаление 7 кастомных тулзов, сжатие `RelayToolDeps`, чистка
   тестов. После подтверждения работоспособности CLI-пути живыми агентами.

## 10. Открытые вопросы — разрешены при реализации

1. **Скачивание media:** снято — в запиненном CLI есть группа `buzz media`
   («Upload and download relay Blossom media»); Blossom-аутентификацию CLI минтит
   сам, расширять loopback-proxy не понадобилось (`blossomHeader` удалён).
2. **`buzz agents`** разрешены по умолчанию (решение владельца); дефолтный
   `deny_commands` пуст, закрыть группу можно конфиг-рекордом:
   `{"buzz_cli":{"deny_commands":["agents"]}}`.
