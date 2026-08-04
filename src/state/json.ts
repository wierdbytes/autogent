/**
 * JSON column helpers.
 *
 * A corrupt blob in a durable table is a data-loss incident, so decoding failures
 * name the row that failed instead of surfacing a bare `SyntaxError`.
 */

export function parseJsonColumn<T>(text: string, column: string, key: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`corrupt ${column} for ${key}: ${detail}`);
  }
}
