/**
 * Model catalog scoped to *authorised* providers — the data source behind the
 * wizard's model/effort pickers.
 *
 * The remote agent only ever sees the credentials inside the profile's
 * auth.json (materialised from the `autogent/auth` record), so ambient auth
 * on the owner's machine (env API keys, AWS profiles) deliberately does not
 * count: a model is offered if and only if the credential file at `authPath`
 * holds a login for its provider. This is what keeps the picker honest — the
 * owner can only select models the deployed Pod will actually be able to use.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

interface SdkModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  /** Missing keys use provider defaults; `null` marks a level unsupported. */
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

interface SdkCatalogRuntime {
  getProviders(): readonly { id: string; name: string }[];
  getModels(providerId?: string): readonly SdkModel[];
  listCredentials(): Promise<readonly { providerId: string }[]>;
}

interface SdkCatalogModule {
  ModelRuntime: {
    create(options: { authPath: string }): Promise<SdkCatalogRuntime>;
  };
}

export interface CatalogModel {
  /** Provider-qualified id (`anthropic/claude-sonnet-4-5`) — the stored shape. */
  ref: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  /** Effort levels this model accepts; empty for non-reasoning models. */
  thinkingLevels: ThinkingLevel[];
}

export interface AuthedProviderCatalog {
  providerId: string;
  providerName: string;
  models: CatalogModel[];
}

function thinkingLevelsOf(model: SdkModel): ThinkingLevel[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  // No map: every pi level is delegated to provider defaults.
  if (!map) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((level) => map[level] !== null);
}

/**
 * Enumerates the providers with a credential stored at `authPath` and the
 * models each one serves. Providers without a login are absent entirely —
 * the caller renders exactly this list, nothing more.
 */
export async function listAuthedCatalog(authPath: string): Promise<AuthedProviderCatalog[]> {
  const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as SdkCatalogModule;
  const runtime = await sdk.ModelRuntime.create({ authPath });

  const authed = new Set((await runtime.listCredentials()).map((info) => info.providerId));
  const catalogs: AuthedProviderCatalog[] = [];
  for (const provider of runtime.getProviders()) {
    if (!authed.has(provider.id)) continue;
    const models = runtime
      .getModels(provider.id)
      .map((model) => ({
        ref: `${provider.id}/${model.id}`,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
        thinkingLevels: thinkingLevelsOf(model),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    catalogs.push({ providerId: provider.id, providerName: provider.name, models });
  }
  return catalogs.sort((a, b) => a.providerName.localeCompare(b.providerName));
}
