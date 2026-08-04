/**
 * Thin `kubectl` wrapper (remote plan §1.2, I2).
 *
 * The provider talks to the cluster exactly the way an operator does — through
 * the ambient kubeconfig — so no cluster credential ever appears in
 * `provider_config` or in this repository. `kube_context` selects among the
 * contexts that already exist on the owner's machine.
 *
 * macOS launches Buzz Desktop with launchd's minimal PATH, which contains no
 * Homebrew kubectl, so the search path is augmented here (spec §Invocation
 * Contract tells providers to do exactly that).
 */

import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { homedir } from "node:os";
import { fail } from "../backend/wire.js";

export interface KubectlOptions {
  context: string | null;
  namespace: string;
  timeoutMs?: number;
}

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

const EXTRA_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  `${homedir()}/.local/bin`,
  "/usr/bin",
  "/bin",
];

function augmentedPath(): string {
  const current = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const merged = [...current];
  for (const entry of EXTRA_PATH_ENTRIES) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  return merged.join(delimiter);
}

export async function kubectl(
  args: string[],
  options: KubectlOptions,
  stdin?: string,
): Promise<KubectlResult> {
  const full = [
    ...(options.context ? ["--context", options.context] : []),
    "--namespace",
    options.namespace,
    ...args,
  ];

  return new Promise<KubectlResult>((resolvePromise, rejectPromise) => {
    const child = spawn("kubectl", full, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: augmentedPath() },
    });

    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`kubectl ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectPromise(
          new Error(
            "kubectl not found on PATH — the k8s provider drives the cluster through the " +
              "ambient kubeconfig and needs kubectl installed on this machine",
          ),
        );
        return;
      }
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** `kubectl apply -f -` for one object; fails loudly with the kubectl stderr. */
export async function apply(object: unknown, options: KubectlOptions): Promise<void> {
  const result = await kubectl(["apply", "-f", "-"], options, JSON.stringify(object));
  if (result.code !== 0) {
    fail(`kubectl apply failed: ${firstLine(result.stderr) || "unknown error"}`);
  }
}

/** `kubectl get … -o json`, returning null when the object does not exist. */
export async function getJson(
  kind: string,
  name: string,
  options: KubectlOptions,
): Promise<Record<string, unknown> | null> {
  const result = await kubectl(["get", kind, name, "-o", "json"], options);
  if (result.code !== 0) {
    if (/notfound/i.test(result.stderr)) return null;
    fail(`kubectl get ${kind}/${name} failed: ${firstLine(result.stderr)}`);
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    fail(`kubectl get ${kind}/${name} returned unparsable JSON`);
  }
}

/** `kubectl get <kind> -l <selector> -o json` → items array. */
export async function listJson(
  kind: string,
  selector: string,
  options: KubectlOptions,
): Promise<Array<Record<string, unknown>>> {
  const result = await kubectl(["get", kind, "-l", selector, "-o", "json"], options);
  if (result.code !== 0) fail(`kubectl get ${kind} -l ${selector} failed: ${firstLine(result.stderr)}`);
  try {
    const parsed = JSON.parse(result.stdout) as { items?: Array<Record<string, unknown>> };
    return parsed.items ?? [];
  } catch {
    fail(`kubectl get ${kind} list returned unparsable JSON`);
  }
}

/** Deletes and waits for the object to be gone. Missing objects are fine. */
export async function deleteAndWait(
  kind: string,
  name: string,
  options: KubectlOptions,
  waitTimeoutSec = 90,
): Promise<void> {
  const result = await kubectl(
    ["delete", kind, name, "--ignore-not-found", `--timeout=${waitTimeoutSec}s`, "--wait=true"],
    { ...options, timeoutMs: (waitTimeoutSec + 15) * 1000 },
    undefined,
  );
  if (result.code !== 0) {
    fail(`kubectl delete ${kind}/${name} failed: ${firstLine(result.stderr)}`);
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}
