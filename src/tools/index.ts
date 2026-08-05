/**
 * Relay tool registry (remote plan §5, §6.2.7).
 *
 * Built once by the runtime and handed to every Pi session as `customTools`.
 * Enabling/disabling individual tools happens through the ordinary pi
 * `tools`/`excludeTools` config — which the core record controls — so the
 * owner can switch a tool off with a config push, hot.
 */

import { channelHistoryTool, channelListTool, channelSearchTool } from "./channel-tools.js";
import type { RelayTool, RelayToolDeps } from "./deps.js";
import { GitAuthProxy, gitReposTool } from "./git-tools.js";
import { mediaGetTool, mediaPutTool } from "./media-tools.js";
import { sendMessageTool } from "./send-message-tool.js";

export { httpOriginOf } from "./deps.js";
export type { RelayTool, RelayToolDeps } from "./deps.js";
export { GitAuthProxy } from "./git-tools.js";

export const RELAY_TOOL_NAMES = [
  "channel_list",
  "channel_history",
  "channel_search",
  "media_get",
  "media_put",
  "git_repos",
  "send_message",
] as const;

export interface RelayToolSet {
  tools: RelayTool[];
  /** Owned by the runtime; closed on shutdown. */
  gitProxy: GitAuthProxy;
}

export function buildRelayTools(deps: RelayToolDeps): RelayToolSet {
  const gitProxy = new GitAuthProxy({
    upstreamOrigin: deps.httpOrigin,
    builder: deps.builder,
    clock: deps.clock,
    logger: deps.logger,
  });

  return {
    gitProxy,
    tools: [
      channelListTool(deps),
      channelHistoryTool(deps),
      channelSearchTool(deps),
      mediaGetTool(deps),
      mediaPutTool(deps),
      gitReposTool(deps, gitProxy),
      sendMessageTool(deps),
    ],
  };
}
