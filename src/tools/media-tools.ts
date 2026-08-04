/**
 * `media_get` / `media_put` — Blossom blobs on the relay (remote plan §5.2).
 *
 * BUD-01/02/11: `PUT /upload` with the blob's SHA-256 bound into both the
 * auth event (`x` tag) and the `X-SHA-256` header; `GET /media/{sha}.{ext}`.
 * Files move only between the relay and the workspace — the tools refuse any
 * path that escapes it, and the state dir is unreachable by construction.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep, extname } from "node:path";
import { blossomHeader } from "./http-auth.js";
import { asToolError, textResult, ToolRefusal, type RelayTool, type RelayToolDeps } from "./deps.js";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

/** Resolves a model-supplied path strictly inside the workspace. */
export function resolveWorkspacePath(workspaceDir: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? candidate : resolve(workspaceDir, candidate);
  const normalizedRoot = resolve(workspaceDir);
  if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + sep)) {
    throw new ToolRefusal(`path ${candidate} is outside the workspace`);
  }
  return absolute;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function mediaPutTool(deps: RelayToolDeps): RelayTool {
  return {
    name: "media_put",
    label: "Upload media",
    description:
      "Upload a file from the workspace to the relay's media store (Blossom). " +
      "Returns the content-addressed URL other members can fetch.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path inside the workspace" },
      },
      required: ["path"],
    },
    async execute(_id, params, signal) {
      try {
        const path = resolveWorkspacePath(deps.workspaceDir, String(params["path"] ?? ""));
        const data = await readFile(path);
        if (data.byteLength > deps.maxMediaBytes) {
          throw new ToolRefusal(
            `file is ${data.byteLength} bytes; the upload ceiling is ${deps.maxMediaBytes}`,
          );
        }
        const sha256 = sha256Hex(data);
        const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

        const doFetch = deps.fetchImpl ?? fetch;
        const response = await doFetch(`${deps.httpOrigin}/upload`, {
          method: "PUT",
          headers: {
            Authorization: blossomHeader(deps.builder, deps.clock, "upload", sha256),
            "X-SHA-256": sha256,
            "Content-Type": contentType,
            "X-Auth-Tag": JSON.stringify([
              "auth",
              deps.builder.authTag.ownerPubkey,
              deps.builder.authTag.conditions,
              deps.builder.authTag.signature,
            ]),
          },
          body: new Uint8Array(data),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          throw new Error(`upload failed: HTTP ${response.status} ${await safeText(response)}`);
        }
        const descriptor = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const url = typeof descriptor["url"] === "string" ? descriptor["url"] : `${deps.httpOrigin}/media/${sha256}`;
        return textResult(`uploaded ${path}\nsha256: ${sha256}\nurl: ${url}`, { sha256, url });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}

export function mediaGetTool(deps: RelayToolDeps): RelayTool {
  return {
    name: "media_get",
    label: "Download media",
    description:
      "Download a blob from the relay's media store by sha256 (or hash URL) into the workspace.",
    parameters: {
      type: "object",
      properties: {
        sha256: {
          type: "string",
          description: "Blob sha256 (64 hex), a {sha256}.{ext} name, or a full /media/ URL",
        },
        path: { type: "string", description: "Destination path inside the workspace" },
      },
      required: ["sha256", "path"],
    },
    async execute(_id, params, signal) {
      try {
        const reference = String(params["sha256"] ?? "").trim();
        const name = reference.includes("/") ? (reference.split("/").pop() ?? "") : reference;
        const sha256 = name.slice(0, 64).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
          throw new ToolRefusal("sha256 must be 64 hex chars (optionally with .ext or a /media/ URL)");
        }
        const destination = resolveWorkspacePath(deps.workspaceDir, String(params["path"] ?? ""));

        const doFetch = deps.fetchImpl ?? fetch;
        const response = await doFetch(`${deps.httpOrigin}/media/${name}`, {
          headers: { Authorization: blossomHeader(deps.builder, deps.clock, "get", sha256) },
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
          throw new Error(`download failed: HTTP ${response.status} ${await safeText(response)}`);
        }
        const data = Buffer.from(await response.arrayBuffer());
        if (data.byteLength > deps.maxMediaBytes) {
          throw new ToolRefusal(`blob is ${data.byteLength} bytes; the ceiling is ${deps.maxMediaBytes}`);
        }
        // BUD-11 hash binding: the relay is not trusted to return what was asked.
        if (sha256Hex(data) !== sha256) {
          throw new Error("downloaded bytes do not hash to the requested sha256 — discarded");
        }
        await writeFile(destination, data);
        return textResult(`saved ${data.byteLength} bytes to ${destination}`, {
          sha256,
          bytes: data.byteLength,
        });
      } catch (error) {
        return asToolError(error);
      }
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}
