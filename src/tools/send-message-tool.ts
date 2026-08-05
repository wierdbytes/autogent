/**
 * `send_message` (remote plan §5.4).
 *
 * *Additional* messages only: the model's ordinary visible output is still
 * published automatically into the triggering thread by the output router,
 * and this tool cannot redirect that. What it adds is cross-posting — a
 * notification into another membership channel, or starting a new thread —
 * through the same durable outbox (write → sign → publish → confirm).
 */

import {
  asToolError,
  resolveChannel,
  textResult,
  ToolRefusal,
  type RelayTool,
  type RelayToolDeps,
} from "./deps.js";

const MAX_BODY_BYTES = 16_000;

export function sendMessageTool(deps: RelayToolDeps): RelayTool {
  return {
    name: "send_message",
    label: "Send channel message",
    description:
      "Send a message into another channel the agent is a member of (cross-post, notification, " +
      "or a new thread). The normal reply to the current conversation is published automatically — " +
      "do NOT use this tool for it.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Target channel id (uuid) or channel name" },
        content: { type: "string", description: "Message body" },
        reply_to: {
          type: "string",
          description: "Optional event id to thread under (root of the reply)",
        },
      },
      required: ["channel", "content"],
    },
    async execute(_id, params) {
      try {
        const content = String(params["content"] ?? "");
        if (content.trim() === "") throw new ToolRefusal("content must not be empty");
        if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) {
          throw new ToolRefusal(`content exceeds ${MAX_BODY_BYTES} bytes`);
        }
        const channel = resolveChannel(deps, params["channel"]).channelId;
        const replyTo = params["reply_to"] === undefined ? null : String(params["reply_to"]);
        const { eventId } = await deps.sendChat(
          channel,
          content,
          replyTo ? { rootEventId: replyTo } : null,
        );
        return textResult(`queued message ${eventId.slice(0, 12)}… to channel ${channel}`, {
          eventId,
          channel,
        });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}
