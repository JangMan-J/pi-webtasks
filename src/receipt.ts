/**
 * Text the agent reads: receipts, alert lines, and error messages, each kept
 * on a bounded budget so it never crowds out the agent's working context.
 */

/** A trimmed string, or undefined when nothing is left. */
export function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Text on one line of at most `limit` characters, cut with an ellipsis. */
export function oneLine(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** The readable message of an error, string, or provider error object on one bounded line; undefined when there is none. */
export function errorText(error: unknown, limit = 160): string | undefined {
  if (error === undefined || error === null || error === "") return undefined;
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === "string") text = error;
  else {
    const message = (error as { message?: unknown }).message;
    try {
      text = typeof message === "string" ? message : JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  return oneLine(text, limit) || undefined;
}
