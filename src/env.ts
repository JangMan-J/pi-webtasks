import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads key files adjacent to the extension (`<extension-root>/.env` and `<extension-root>/parallel.env`)
 * into process.env before any tool runs. Real environment variables always win; nothing here overrides a
 * set variable. Key files use the provider's own names (_PARALLEL_API_KEY, PARALLEL_WEBHOOK_KEY).
 * No Pi imports: safe for the standalone webhook receiver as well.
 */

/** Parse dotenv-style text. Supports blank lines, `#` comments, `export KEY=`, and quoted values. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Apply entries without overriding variables that are already set. An explicit empty value counts as set. */
export function applyEnv(entries: Record<string, string>, env: Record<string, string | undefined> = process.env): void {
  for (const [key, value] of Object.entries(entries)) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** This module lives in `src/`; key files live in the extension root. */
const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

for (const name of [".env", "parallel.env"]) {
  try {
    applyEnv(parseEnvText(readFileSync(join(EXTENSION_ROOT, name), "utf8")));
  } catch {
    /* no readable key file at this path */
  }
}
