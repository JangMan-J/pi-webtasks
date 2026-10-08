import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads key files adjacent to the extension (`<extension-root>/.env` and
 * `<extension-root>/parallel.env`) into process.env before any tool runs.
 * Real environment variables always win; nothing here overrides a set var.
 * No Pi imports: safe for the standalone webhook receiver as well.
 */

/** The env file uses the Parallel account's natural names; the extension reads PIPARA_* names. */
const ALIASES: Record<string, string> = {
  _PARALLEL_API_KEY: "PIPARA_API_KEY",
  PARALLEL_API_KEY: "PIPARA_API_KEY",
  PARALLEL_WEBHOOK_KEY: "PIPARA_WEBHOOK_SECRET",
};

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

/** Apply entries without overriding variables that are already set, including aliases. */
export function applyEnv(entries: Record<string, string>, env: Record<string, string | undefined> = process.env): void {
  for (const [key, value] of Object.entries(entries)) {
    if (env[key] === undefined) env[key] = value;
    const alias = ALIASES[key];
    if (alias && env[alias] === undefined) env[alias] = env[key];
  }
}

/**
 * Map the deployed names (_PARALLEL_API_KEY, PARALLEL_WEBHOOK_KEY) already in
 * the environment onto the PIPARA_* names, so a key exported by the shell or a
 * secrets manager works with no key file. A set PIPARA_* value (even "") wins.
 */
export function applyAliases(env: Record<string, string | undefined> = process.env): void {
  for (const [natural, alias] of Object.entries(ALIASES)) {
    if (env[alias] === undefined && env[natural] !== undefined) env[alias] = env[natural];
  }
}

/** This module lives in `src/`; key files live in the extension root. */
const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Exported credentials must win over compatibility key files and aliases.
applyAliases();
for (const name of [".env", "parallel.env"]) {
  try {
    applyEnv(parseEnvText(readFileSync(join(EXTENSION_ROOT, name), "utf8")));
  } catch {
    /* no readable key file at this path */
  }
}
applyAliases();
