#!/usr/bin/env node
/**
 * `buzz` shim (buzz-cli plan §4).
 *
 * Installed as /usr/local/bin/buzz in the container image (a .cjs source:
 * the autogent repo is "type": "module", but the shim must stay CommonJS to
 * run from any path). The bash
 * environment carries no credentials (autogent strips them deliberately), so
 * this shim cannot and does not authenticate: it forwards
 * `{argv, cwd, stdin}` over a unix socket to the autogent broker, which runs
 * the real CLI with the key injected, and prints the result back.
 *
 * Protocol: one JSON line request, one JSON response, one connection per
 * command. stdin is forwarded so `… | buzz messages send --content -` works.
 */

"use strict";

const net = require("node:net");
const path = require("node:path");

// Hardcoded to mirror the broker: $TMPDIR survives the harness's child-env
// allowlist, everything else credential-shaped does not. AUTOGENT_BUZZ_SOCKET
// is a test hook — the prefix is stripped from real bash environments.
const socketPath =
  process.env.AUTOGENT_BUZZ_SOCKET ||
  path.join(process.env.TMPDIR || "/tmp", "autogent-buzz.sock");

function fail(message) {
  process.stderr.write(JSON.stringify({ error: "harness", message }) + "\n");
  process.exit(4);
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(null));
  });
}

async function main() {
  const stdin = await readStdin();
  const request = JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
  });

  const socket = net.connect(socketPath);
  const chunks = [];

  socket.on("connect", () => {
    socket.write(request + "\n");
  });
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("error", () => {
    fail("buzz is not available in this environment (broker socket not reachable)");
  });
  socket.on("close", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw === "") fail("buzz broker closed the connection without a response");
    let response;
    try {
      response = JSON.parse(raw);
    } catch {
      fail("buzz broker returned a malformed response");
      return;
    }
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exit(Number.isInteger(response.exitCode) ? response.exitCode : 4);
  });
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
