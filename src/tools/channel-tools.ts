/**
 * `channel_list` / `channel_history` / `channel_search` (remote plan §5.1).
 *
 * Straight one-shot REQs against the relay: NIP-50 `search` for relevance
 * queries, plain `#h` + since/until/limit for tail reads. Access control is
 * the relay's job (membership-gated, fail-closed); the tools only refuse
 * early on channels the agent does not even know, so the model cannot probe
 * for the existence of foreign channels through error-message differences.
 */

import { KIND, tagValue, type NostrEvent } from "../nostr/types.js";
import {
  textResult,
  ToolRefusal,
  asToolError,
  resolveChannel,
  type RelayTool,
  type RelayToolDeps,
} from "./deps.js";

const RESULT_CAP = 50;

function formatMessages(events: NostrEvent[]): string {
  if (events.length === 0) return "no messages found";
  const lines = events.map((event) => {
    const thread = tagValue(event, "e");
    const when = new Date(event.created_at * 1000).toISOString();
    const body = event.content.length > 500 ? `${event.content.slice(0, 500)}…` : event.content;
    return [
      `[${when}] ${event.pubkey.slice(0, 12)}… (event ${event.id.slice(0, 12)}…${thread ? `, thread ${thread.slice(0, 12)}…` : ""})`,
      body,
    ].join("\n");
  });
  return lines.join("\n---\n");
}

export function channelListTool(deps: RelayToolDeps): RelayTool {
  return {
    name: "channel_list",
    label: "List channels",
    description:
      "List the channels the agent is a member of: name, channel id and type. " +
      "Use the id (or a unique name) with channel_history, channel_search and send_message.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const directory = deps.channelDirectory();
        if (directory.length === 0) return textResult("no channel memberships", { count: 0 });
        const lines = directory.map(
          (channel) =>
            `${channel.name ?? "(unnamed)"} — ${channel.channelId} [${channel.channelType}]`,
        );
        return textResult(lines.join("\n"), { count: directory.length, channels: directory });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}

export function channelHistoryTool(deps: RelayToolDeps): RelayTool {
  return {
    name: "channel_history",
    label: "Channel history",
    description:
      "Read recent messages from a channel the agent is a member of. Returns messages " +
      "oldest-first with author pubkeys and event ids. Use channel_search for keyword search.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel id (uuid) or channel name" },
        limit: { type: "number", description: `Max messages (default 20, cap ${RESULT_CAP})` },
        since: { type: "number", description: "Unix seconds lower bound (optional)" },
        until: { type: "number", description: "Unix seconds upper bound (optional)" },
      },
      required: ["channel"],
    },
    async execute(_id, params) {
      try {
        const channel = resolveChannel(deps, params["channel"]).channelId;
        const limit = Math.min(Math.max(Number(params["limit"]) || 20, 1), RESULT_CAP);
        const events = await deps.relay.query([
          {
            kinds: [KIND.CHAT],
            "#h": [channel],
            limit,
            ...(Number(params["since"]) > 0 ? { since: Number(params["since"]) } : {}),
            ...(Number(params["until"]) > 0 ? { until: Number(params["until"]) } : {}),
          },
        ]);
        const ordered = [...events].sort((a, b) => a.created_at - b.created_at).slice(-limit);
        return textResult(formatMessages(ordered), { count: ordered.length });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}

export function channelSearchTool(deps: RelayToolDeps): RelayTool {
  return {
    name: "channel_search",
    label: "Channel search",
    description:
      "Full-text search (NIP-50) over a channel's message history on the relay. " +
      "Results are relevance-sorted by the relay.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel id (uuid) or channel name" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: `Max results (default 20, cap ${RESULT_CAP})` },
      },
      required: ["channel", "query"],
    },
    async execute(_id, params) {
      try {
        const query = String(params["query"] ?? "").trim();
        if (query === "") throw new ToolRefusal("query must not be empty");
        const channel = resolveChannel(deps, params["channel"]).channelId;
        const limit = Math.min(Math.max(Number(params["limit"]) || 20, 1), RESULT_CAP);
        const events = await deps.relay.query([
          // NIP-50: relevance order — deliberately not re-sorted by time.
          { kinds: [KIND.CHAT], "#h": [channel], search: query, limit },
        ]);
        return textResult(formatMessages(events.slice(0, limit)), { count: events.length });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}
