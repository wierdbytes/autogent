/**
 * Reshapes the SDK-built system prompt for buzz agents.
 *
 * Pi's default system prompt carries two sections that are dead weight for a
 * chat agent — `Guidelines:` (generic coding-assistant etiquette) and
 * `Pi documentation …` (paths into the SDK's own docs) — and it lacks the
 * conversation context (channel, scope, self username, reply routing). This
 * module removes the former and inserts the latter directly below the
 * `Current working directory:` line.
 *
 * Implemented as an inline extension on the `before_agent_start` hook: the SDK
 * offers no option to drop individual sections from the assembled prompt, but
 * the hook may replace the whole prompt per turn, which amounts to the same
 * thing and survives resource reloads.
 */

/** Paragraph prefixes stripped from the default prompt. */
const DROPPED_SECTION_PREFIXES = ["Guidelines:", "Pi documentation"];

const CWD_LINE = /^Current working directory: .*$/m;

/**
 * Pure transform: drops the unwanted sections and appends `contextLines`
 * right below the `Current working directory` line (or at the end when the
 * prompt has no such line, e.g. a fully custom prompt).
 */
export function shapeSystemPrompt(prompt: string, contextLines: readonly string[]): string {
  const paragraphs = prompt.split("\n\n");
  const kept = paragraphs.filter(
    (paragraph) => !DROPPED_SECTION_PREFIXES.some((prefix) => paragraph.startsWith(prefix)),
  );
  let shaped = kept.join("\n\n");
  if (contextLines.length === 0) return shaped;

  const block = contextLines.join("\n");
  if (CWD_LINE.test(shaped)) {
    shaped = shaped.replace(CWD_LINE, (line) => `${line}\n${block}`);
  } else {
    shaped = `${shaped}\n\n${block}`;
  }
  return shaped;
}

/** Minimal structural slice of the SDK's `ExtensionAPI` used by the shaper. */
interface ShaperExtensionApi {
  on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => unknown): void;
}

/**
 * Inline extension factory for `DefaultResourceLoader`'s `extensionFactories`.
 *
 * `before_agent_start` fires on every turn with the fully assembled prompt
 * (base + appendSystemPrompt + project context + skills + cwd), so the shape
 * survives tool-set changes and resource reloads without extra wiring.
 */
export function systemPromptShaperExtension(
  contextLines: readonly string[],
): (pi: ShaperExtensionApi) => void {
  return (pi) => {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: shapeSystemPrompt(event.systemPrompt, contextLines),
    }));
  };
}
