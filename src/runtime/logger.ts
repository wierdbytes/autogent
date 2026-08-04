import { redact } from "../security/redaction.js";
import type { LogLevel, Logger } from "./ports.js";

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Structured stderr logger.
 *
 * stdout is left free so the process can be piped without log noise polluting
 * machine-readable output. Every field is redacted before serialisation.
 */
class StderrLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly base: Record<string, unknown> = {},
  ) {}

  #log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;
    const line = {
      t: new Date().toISOString(),
      level,
      msg: message,
      ...(redact(this.base) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.#log("error", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.#log("warn", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.#log("info", message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.#log("debug", message, fields);
  }
  child(fields: Record<string, unknown>): Logger {
    return new StderrLogger(this.level, { ...this.base, ...fields });
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  return new StderrLogger(level);
}

/** Discards everything. Default in tests. */
export const nullLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => nullLogger,
};
