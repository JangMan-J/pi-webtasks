// Parallel as a Pi provider, registered the same way any provider is. It lists no models, so it adds
// nothing to the model picker. Pi's /login offers "Sign in with an API key" for it: the login shows the
// dashboard link, then asks for the key and stores it in Pi's auth.json under this provider id.
// Only type-level imports from pi-ai, so this module loads without the Pi runtime.
import type { ApiKeyCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";

export const PARALLEL_PROVIDER_ID = "parallel";
export const PARALLEL_KEY_URL = "https://platform.parallel.ai/settings?tab=api-keys";
export const PARALLEL_KEY_PROMPT = "Parallel API key";

/**
 * `Provider` requires the streaming members (pi-ai models.d.ts:112-113, 1.1.0), even with no models. Parallel has
 * no chat model for Pi to stream, so these can only be reached if something asks for a stream without a model.
 */
function noChatStream(): never {
  throw new Error("Parallel is a research key, not a chat provider. It has no chat models.");
}

export function parallelProvider(): Provider {
  return {
    id: PARALLEL_PROVIDER_ID,
    name: "Parallel",
    auth: {
      apiKey: {
        name: "Parallel API key",
        async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
          interaction.notify({
            type: "auth_url",
            url: PARALLEL_KEY_URL,
            instructions: "Sign in, copy an API key, and paste it here.",
          });
          const entered = (await interaction.prompt({ type: "secret", message: PARALLEL_KEY_PROMPT })).trim();
          // Throwing here means Pi stores nothing: it persists a credential only after login resolves.
          if (!entered) throw new Error("No Parallel API key was entered. Nothing was saved.");
          return { type: "api_key", key: entered };
        },
        // The stored key first, then the environment. Package key files are not in the environment; the
        // research client checks them after this.
        async resolve({ ctx, credential }) {
          const stored = credential?.type === "api_key" ? credential.key?.trim() : undefined;
          if (stored) return { auth: { apiKey: stored }, source: "stored credential" };
          const fromEnv = ((await ctx.env("_PARALLEL_API_KEY")) ?? (await ctx.env("PARALLEL_API_KEY")))?.trim();
          return fromEnv ? { auth: { apiKey: fromEnv }, source: "environment" } : undefined;
        },
      },
    },
    // No models. getModels() is synchronous and always empty, so the picker gets no Parallel entries.
    getModels: () => [],
    stream: noChatStream,
    streamSimple: noChatStream,
  };
}
