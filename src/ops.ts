/**
 * Parallel client plumbing shared by every research call.
 *
 * The key precedence rule lives here so the extension, tests, and any future
 * caller resolve credentials the same way. Nothing here retries: the client is
 * built with `maxRetries: 0`, and call sites pass it explicitly as well.
 */

import { packageAdjacentKey } from "./env.ts";
import { Parallel, APIError } from "parallel-web";

/** Where a key stored by Pi's /login comes from. Absent when the caller runs without Pi. */
export type StoredKey = () => Promise<string | undefined>;

/** Shown when Pi runs the extension. The sentence names the one step a user can take inside Pi. */
export const MISSING_KEY_IN_PI = "Run /login, choose Parallel, and paste an API key — or set _PARALLEL_API_KEY.";
/** Shown when there is no Pi login, so the only sources are the environment and the package key file. */
export const MISSING_KEY_STANDALONE = "Parallel API key missing. Set _PARALLEL_API_KEY in the environment, or put it in .env or parallel.env beside the package manifest.";

export type KeySource = "stored credential" | "environment" | "key file";

/**
 * The one precedence rule for the research key: the stored login, then _PARALLEL_API_KEY, then
 * PARALLEL_API_KEY from the environment, then the package-adjacent key file. Pure, so tests can drive it.
 */
export function resolveResearchKey(input: {
  stored?: string;
  env?: Record<string, string | undefined>;
  packageKey?: string;
}): { key: string; source: KeySource } | undefined {
  const stored = input.stored?.trim();
  if (stored) return { key: stored, source: "stored credential" };
  const env = input.env ?? process.env;
  for (const name of ["_PARALLEL_API_KEY", "PARALLEL_API_KEY"]) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: "environment" };
  }
  const file = input.packageKey?.trim();
  return file ? { key: file, source: "key file" } : undefined;
}

/** Resolved on every call, never cached, so a login or logout takes effect on the next request. */
export async function researchKey(stored?: StoredKey): Promise<string> {
  const resolved = resolveResearchKey({ stored: stored ? await stored() : undefined, packageKey: packageAdjacentKey() });
  if (!resolved) throw new Error(stored ? MISSING_KEY_IN_PI : MISSING_KEY_STANDALONE);
  return resolved.key;
}

export async function researchClient(stored?: StoredKey): Promise<Parallel> {
  return new Parallel({ apiKey: await researchKey(stored), timeout: 120_000, maxRetries: 0 });
}

/** A readable message for a provider or local failure, without leaking credentials. */
export function formatError(err: unknown): string {
  if (err instanceof APIError) {
    try {
      return JSON.stringify(err.error ?? err.message, null, 2);
    } catch {
      return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
