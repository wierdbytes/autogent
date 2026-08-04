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
| presence `degraded` | агент жив, но fail-closed: нет core-engram или креды невалидны/отозваны. Промпты отвергаются, `!shutdown` работает |
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
  engram; работающий агент подхватит его по подписке без рестарта.
- **Отзыв намеренный**: `autogent-nostr auth revoke --agent <pubkey>`
  публикует tombstone; агент уходит в degraded немедленно.
- Правило слияния одно: свежее (по `created_at`) побеждает; агент сам
  публикует недостающую сторону при старте.

### Потеря PVC

Потеряны: транскрипты сессий, SQLite-история, workspace-клоны.
**Не потеряно ничего невосстановимого**: identity приедет из Secret'а при
следующем деплое, конфиг и OAuth-креды — из engram-голов (acceptance §12.3).

1. Удалить осиротевший PVC: `kubectl delete pvc autogent-<pubkey12>-data`.
2. Redeploy из Buzz Desktop. Всё.

### Redeploy / обновление образа

Buzz Desktop → Deploy. Провайдер: новый generation-Secret → замена Pod'а
(старый дожидается graceful-остановки, второго живого не бывает, I4) → GC
старых Secret'ов. Обновление конфига **без** смены образа redeploy не
требует: изменение записи агента переподписывает core-engram, агент
применяет его на лету.

### Остановка

Только `!shutdown` из канала (owner-gated). Прямой `kubectl delete pod` —
крайняя мера: агент получит SIGTERM и корректно попрощается (бюджет 60s),
но Desktop не узнает, что остановка была намеренной.

### Переезд в AKS

1. `az aks get-credentials …` — новый контекст в kubeconfig.
2. Namespace + NetworkPolicy: `kubectl apply -f deploy/k8s/`.
3. В provider_config агента: `kube_context` → AKS-контекст,
   `storage_class` → `managed-csi` (или пусто для default).
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
| конфиг агента | engram `core` (kind 30174), шифртекст NIP-44 |
| OAuth-креды | engram `mem/provider-auth` + `~/.config/autogent/agents/<pubkey>/auth.json` на owner-машине |
| состояние/workspace | PVC `autogent-<pubkey12>-data`, смонтирован в `/data` |
| образ | `ghcr.io/wierdbytes/autogent` (тег резолвится в digest при деплое; Pod всегда digest-pinned) |
