# Runbook: autogent на удалённых нодах

Операционные процедуры для агентов, задеплоенных через
`buzz-backend-autogent-k8s` (план: `docs/plans/20260804-remote-nodes.md`).

Инструменты наблюдения — **релей, не kubectl**: presence (kind `20001`) — это
статус (I3), kubectl — это хирургия.

---

## Как читать состояние агента

| Наблюдение | Значение |
|---|---|
| presence `online` + heartbeat каждые 60s | агент жив и принимает промпты |
| presence `degraded` | агент жив, но fail-closed: нет config-записи (`autogent/config`) или креды невалидны/отозваны. Промпты отвергаются, `!shutdown` работает |
| presence молчит > 180s | процесс мёртв или сеть до релея потеряна |
| Pod `Succeeded` (exit 0) | намеренное завершение: `!shutdown` или inactivity-таймер (I5). Рестарта не будет — это норма |
| Pod `Failed` / рестарты при `OnFailure` | краш; смотреть `kubectl logs` |

```bash
kubectl --context k3s-agents -n autogent get pods -l app=autogent-agent
kubectl --context k3s-agents -n autogent logs autogent-<pubkey12> --tail=200
```

---

## Сценарии

### Упавший Pod

1. `kubectl logs` (флаг `-p` для предыдущей попытки). Типовые причины:
   релей недоступен (exit 1, `relay_terminal`), поломанный образ, OOM.
2. `inactivity_seconds > 0` (restartPolicy `Never`): упавший Pod не
   рестартует сам — **Redeploy из Buzz Desktop** после устранения причины.
3. `inactivity_seconds = 0` (`OnFailure`): k8s рестартует сам; если
   crash-loop — чинить причину, Pod не трогать.
4. Состояние (SQLite, workspace, pi auth.json) живёт на PVC и переживает
   любое пересоздание Pod'а.

### Протухшие / отозванные креды

Симптом: presence `degraded`, в логах `provider-auth` ошибки.

- **Рефреш сломался** (revoked OAuth): на owner-машине
  `autogent-nostr auth login --agent <pubkey>` — новый флоу перезапишет
  config-запись (kind 30078); работающий агент подхватит её по подписке без рестарта.
- **Отзыв намеренный**: `autogent-nostr auth revoke --agent <pubkey>`
  публикует tombstone; агент уходит в degraded немедленно.
- Правило слияния одно: свежее (по `created_at`) побеждает; агент сам
  публикует недостающую сторону при старте.

### Потеря PVC

Потеряны: транскрипты сессий, SQLite-история, workspace-клоны.
**Не потеряно ничего невосстановимого**: identity приедет из Secret'а при
следующем деплое, конфиг и OAuth-креды — из голов config-записей (acceptance §12.3).

1. Удалить осиротевший PVC: `kubectl delete pvc autogent-<pubkey12>-data`.
2. Redeploy из Buzz Desktop. Всё.

### Redeploy / обновление образа

Buzz Desktop → Deploy. Провайдер: новый generation-Secret → замена Pod'а
(старый дожидается graceful-остановки, второго живого не бывает, I4) → GC
старых Secret'ов. Обновление конфига **без** смены образа redeploy не
требует: изменение записи агента переподписывает config-запись, агент
применяет её на лету. Точечное обновление без Buzz Desktop:
`autogent-nostr config publish --agent <pubkey> --file config.json`.

### Остановка

Только `!shutdown` из канала (owner-gated). Прямой `kubectl delete pod` —
крайняя мера: агент получит SIGTERM и корректно попрощается (бюджет 60s),
но Desktop не узнает, что остановка была намеренной.

### Достать файл сессии для дебага

Транскрипт Pi-сессии — это `.jsonl` (каждая строка — event/message), полезен
для разбора «что модель видела и почему так ответила».

**1. Профиль → pubkey → Pod.** Имя Pod'а строится из pubkey, не из имени
профиля. Маппинг лежит в реестре на owner-машине:

```bash
python3 -c "import json;print({p['name']:p.get('agentPubkey') for p in json.load(open('$HOME/.config/autogent/registry.json'))['profiles']})"
# Pod = autogent-<первые 12 символов pubkey>, например autogent-139206ac2fb8
```

**2. Найти файлы сессий внутри Pod'а.** Pi SDK пишет транскрипты **не на
PVC**, а в home контейнера:

```bash
kubectl -n autogent exec autogent-<pubkey12> -- \
  sh -c 'find $HOME/.pi/agent/sessions -name "*.jsonl"'
# → /home/agent/.pi/agent/sessions/--data-workspace--/<timestamp>_<session-id>.jsonl
```

Если файлов несколько (несколько каналов), маппинг «канал → файл» хранится в
SQLite на PVC: `/data/state/agent.db`, таблица channels (колонка с
`pi_session_path`; пишется в `session-registry.ts` → `setPiSession`).

**3. Скопировать на owner-машину.** Через `cat` (не требует `tar` в образе,
в отличие от `kubectl cp`):

```bash
kubectl -n autogent exec autogent-<pubkey12> -- \
  cat '/home/agent/.pi/agent/sessions/--data-workspace--/<файл>.jsonl' \
  > ~/me/tmp/<профиль>-session.jsonl
```

Все сессии разом:

```bash
kubectl -n autogent exec autogent-<pubkey12> -- \
  sh -c 'cd $HOME/.pi/agent/sessions && tar cf - .' | tar xf - -C <куда>
```

**4. Изучать.** Формат — Pi session v3: строка 0 — заголовок (`type:
"session"`, id, cwd), дальше `model_change` / `thinking_level_change` /
`message`. Открыть локально: `pi --session <файл>.jsonl`, либо построчно
через `jq`.

**Нюанс — файл смертен.** Он живёт в `/home/agent` (файловая система
контейнера), а не на PVC: пересоздание Pod'а его уничтожает, при этом SQLite
на PVC продолжит ссылаться на несуществующий путь (тогда registry молча
откроет свежую сессию — `#open` в `session-registry.ts`). Ценные транскрипты
забирать сразу, пока Pod жив.

### Langfuse tracing

Опционально агент шлёт трейсы в Langfuse (cloud или self-hosted): один trace
на turn, generation-observations с usage/cost на каждый вызов модели, span на
каждый tool call, Nostr-метаданные (канал, автор, relay) для фильтрации
(план: `docs/plans/20260806-langfuse-tracing.md`).

**Включение.** Блок `langfuse` в конфиге агента (`autogent/config`, публикуется
через `config publish`):

```json
{
  "v": 1,
  "langfuse": {
    "enabled": true,
    "host": "https://cloud.langfuse.com",
    "privacy": "conversations",
    "sample_rate": 1
  }
}
```

Для локального (нерелейного) режима те же поля задаются через
`AUTOGENT_LANGFUSE` / `AUTOGENT_LANGFUSE_HOST` / `AUTOGENT_LANGFUSE_PRIVACY` /
`AUTOGENT_LANGFUSE_SAMPLE` / `AUTOGENT_LANGFUSE_ENV`, а сами ключи — через
стандартные для экосистемы Langfuse `LANGFUSE_PUBLIC_KEY` /
`LANGFUSE_SECRET_KEY`.

**Ключи (remote).** `enabled: true` в конфиге ещё не даёт агенту ключей —
они едут отдельным каналом, ровно как `auth login/revoke`:

```bash
autogent-nostr langfuse set    --agent <pubkey>   # запрашивает pk-lf-.../sk-lf-... интерактивно,
                                                    # либо --public-key/--secret-key
autogent-nostr langfuse status --agent <pubkey>
autogent-nostr langfuse revoke --agent <pubkey>    # tombstone
```

`set` публикует record `autogent/langfuse` (kind 30078, NIP-44-шифрован под
self-key агента — как `autogent/auth`); работающий агент подхватывает его по
живой подписке и переконфигурирует publisher без рестарта. `revoke`
публикует tombstone (`value: null`): агент выключает tracing на лету и
продолжает работать как обычно — это degrade только трейсинга, не самого
агента. `status` печатает `created_at` головы и public key; secret key
никогда не печатается (`sk-lf-***`).

**Privacy-пресеты.** Выбираются владельцем при настройке профиля
(`langfuse.privacy` в конфиге), enforced публикатором:

| Поле | `metadata-only` | `conversations` (default) | `full` |
| --- | :-: | :-: | :-: |
| Nostr-метаданные, usage, cost, тайминги, имена tool'ов, error-флаги | ✅ | ✅ | ✅ |
| prompt (input) и текст ответа (output) | — | ✅ | ✅ |
| thinking, tool input/output | — | — | ✅ |
| систем-промпт (полный эффективный) | — | — | ✅ |

Default — `conversations`: агент читает чужие сообщения из каналов, а tool
I/O может содержать содержимое файлов и вывод команд — это самый рискованный
слой, поэтому `full` не default.

**Fail-closed-degraded, но только для трейсинга.** `enabled: true` без
разрешённых credentials (ни record, ни env) — один warn в лог, agent работает
дальше как обычно, просто без трейсов (no-op tracing port). Это отличается от
деградации самого агента (нет `autogent/config` или невалидные provider-креды) —
отсутствие Langfuse-ключей никогда не блокирует промпты.

### Переезд в AKS

1. `az aks get-credentials …` — новый контекст в kubeconfig.
2. Namespace + NetworkPolicy: `kubectl apply -f deploy/k8s/`.
3. В интерактивном `autogent` (Edit parameters у профиля): kube context →
   AKS-контекст, storage class → `managed-csi` (или пусто для default).
   provider_config в Buzz теперь содержит только имя профиля.
4. Redeploy. PVC-содержимое не переносится (см. «Потеря PVC» — оно и не
   нужно); при необходимости workspace переносится вручную
   (`kubectl cp` со старого кластера до удаления).
5. Старые объекты на k3s удалить label-select'ом:
   `kubectl --context k3s-agents -n autogent delete pod,secret,pvc -l app=autogent-agent`.

---

## Что где лежит

| Артефакт | Место |
|---|---|
| nsec | k8s Secret `autogent-<pubkey12>-<generation>` + OS keyring owner'а |
| конфиг агента | config-запись `autogent/config` (kind 30078), NIP-44-шифртекст к собственному ключу агента |
| OAuth-креды | config-запись `autogent/auth` + `~/.config/autogent/agents/<pubkey>/auth.json` на owner-машине |
| Langfuse-ключи | config-запись `autogent/langfuse` (kind 30078), NIP-44-шифртекст к собственному ключу агента; owner управляет `autogent-nostr langfuse set/status/revoke` |
| состояние/workspace | PVC `autogent-<pubkey12>-data`, смонтирован в `/data` |
| транскрипты Pi-сессий | `/home/agent/.pi/agent/sessions/--data-workspace--/*.jsonl` — **вне PVC**, гибнут с Pod'ом; см. «Достать файл сессии для дебага» |
| образ | `ghcr.io/wierdbytes/autogent` (тег резолвится в digest при деплое; Pod всегда digest-pinned) |
