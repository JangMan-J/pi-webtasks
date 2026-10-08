// Parallel as a Pi provider, registered the same way any provider is. It lists no models, so it adds
// nothing to the model picker. Pi's /login offers two sign-in methods for it: a browser sign-in (OAuth PKCE,
// see parallel-oauth.ts) and an API-key paste. Both store under this provider id in Pi's auth.json.
// Only type-level imports from pi-ai, so this module loads without the Pi runtime.
import type { ApiKeyCredential, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { browserLogin, type BrowserLoginOptions } from "./parallel-oauth.ts";

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

export function parallelProvider(options: BrowserLoginOptions = {}): Provider {
  return {
    id: PARALLEL_PROVIDER_ID,
    name: "Parallel",
    auth: {
      oauth: {
        name: "Parallel",
        loginLabel: "Sign in with Parallel (browser)",
        isSubscription: false,
        login: interaction => browserLogin(interaction, options),
        // The key is long-lived with no refresh grant, so refreshing returns the stored credential unchanged.
        async refresh(credential: OAuthCredential) { return credential; },
        async toAuth(credential: OAuthCredential) { return { apiKey: credential.access }; },
      },
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
