import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import type { CredentialStorageStatus } from "../shared/contracts";
import type { AppEnv } from "./env";

export const credentialProviderSchema = z.enum(["openai", "exa", "firecrawl"]);
export type CredentialProvider = z.infer<typeof credentialProviderSchema>;

export type ProviderCredentials = {
  OPENAI_API_KEY?: string;
  EXA_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
};

const storedCredentialSchema = z.object({
  ciphertext: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

const credentialFileSchema = z.object({
  version: z.literal(1),
  providers: z.partialRecord(credentialProviderSchema, storedCredentialSchema),
  ignoredEnvironmentProviders: z.array(credentialProviderSchema).default([]),
});

type CredentialFile = z.infer<typeof credentialFileSchema>;
type StoredCredential = z.infer<typeof storedCredentialSchema>;

const ENV_KEYS: Record<CredentialProvider, keyof AppEnv> = {
  openai: "OPENAI_API_KEY",
  exa: "EXA_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
};

export class CredentialVault {
  private readonly credentials: Partial<Record<CredentialProvider, string>> = {};
  private readonly sources: Partial<Record<CredentialProvider, "secure-storage" | "environment">> =
    {};
  private stored: CredentialFile = {
    version: 1,
    providers: {},
    ignoredEnvironmentProviders: [],
  };

  constructor(private readonly path: string) {}

  async initialize(environment: AppEnv): Promise<void> {
    this.stored = await this.readStoredFile();
    let storedChanged = false;
    if (this.storageStatus().available) {
      for (const [provider, entry] of Object.entries(this.stored.providers)) {
        if (entry == null) continue;
        try {
          this.credentials[provider as CredentialProvider] = safeStorage.decryptString(
            Buffer.from(entry.ciphertext, "base64"),
          );
          this.sources[provider as CredentialProvider] = "secure-storage";
        } catch {
          delete this.stored.providers[provider as CredentialProvider];
          storedChanged = true;
        }
      }
    }

    let migrated = false;
    const ignoredEnvironmentProviders = new Set(this.stored.ignoredEnvironmentProviders);
    for (const provider of credentialProviderSchema.options) {
      const fromEnvironment = environment[ENV_KEYS[provider]];
      if (
        this.credentials[provider] != null ||
        fromEnvironment == null ||
        ignoredEnvironmentProviders.has(provider)
      ) {
        continue;
      }
      this.credentials[provider] = fromEnvironment;
      if (this.storageStatus().available) {
        this.stored.providers[provider] = encryptCredential(fromEnvironment);
        this.sources[provider] = "secure-storage";
        migrated = true;
      } else {
        this.sources[provider] = "environment";
      }
    }
    if (migrated || storedChanged) await this.writeStoredFile();
  }

  get(provider: CredentialProvider): string | undefined {
    return this.credentials[provider];
  }

  source(provider: CredentialProvider): "secure-storage" | "environment" | "missing" {
    return this.sources[provider] ?? "missing";
  }

  all(): ProviderCredentials {
    return {
      ...(this.credentials.openai == null ? {} : { OPENAI_API_KEY: this.credentials.openai }),
      ...(this.credentials.exa == null ? {} : { EXA_API_KEY: this.credentials.exa }),
      ...(this.credentials.firecrawl == null
        ? {}
        : { FIRECRAWL_API_KEY: this.credentials.firecrawl }),
    };
  }

  async set(provider: CredentialProvider, value: string): Promise<void> {
    const normalized = value.trim();
    if (normalized.length < 8) throw new Error("The provider credential is too short.");
    if (!this.storageStatus().available) {
      throw new Error(
        "Secure OS credential storage is unavailable. Configure this provider through the process environment instead.",
      );
    }
    const previousCredential = this.credentials[provider];
    const previousSource = this.sources[provider];
    const previousStored = this.stored.providers[provider];
    const previousIgnored = [...this.stored.ignoredEnvironmentProviders];
    this.credentials[provider] = normalized;
    this.sources[provider] = "secure-storage";
    this.stored.providers[provider] = encryptCredential(normalized);
    this.stored.ignoredEnvironmentProviders = this.stored.ignoredEnvironmentProviders.filter(
      (candidate) => candidate !== provider,
    );
    try {
      await this.writeStoredFile();
    } catch (error) {
      restoreOptional(this.credentials, provider, previousCredential);
      restoreOptional(this.sources, provider, previousSource);
      restoreOptional(this.stored.providers, provider, previousStored);
      this.stored.ignoredEnvironmentProviders = previousIgnored;
      throw error;
    }
  }

  async clear(provider: CredentialProvider): Promise<void> {
    const previousCredential = this.credentials[provider];
    const previousSource = this.sources[provider];
    const previousStored = this.stored.providers[provider];
    const previousIgnored = [...this.stored.ignoredEnvironmentProviders];
    delete this.credentials[provider];
    delete this.sources[provider];
    delete this.stored.providers[provider];
    if (!this.stored.ignoredEnvironmentProviders.includes(provider)) {
      this.stored.ignoredEnvironmentProviders.push(provider);
    }
    try {
      await this.writeStoredFile();
    } catch (error) {
      restoreOptional(this.credentials, provider, previousCredential);
      restoreOptional(this.sources, provider, previousSource);
      restoreOptional(this.stored.providers, provider, previousStored);
      this.stored.ignoredEnvironmentProviders = previousIgnored;
      throw error;
    }
  }

  storageStatus(): CredentialStorageStatus {
    if (!safeStorage.isEncryptionAvailable()) {
      return { available: false, backend: "unavailable" };
    }
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      return {
        available: backend !== "basic_text",
        backend,
      };
    }
    return {
      available: true,
      backend: process.platform === "darwin" ? "keychain" : "dpapi",
    };
  }

  private async readStoredFile(): Promise<CredentialFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = credentialFileSchema.safeParse(JSON.parse(raw));
      return parsed.success
        ? parsed.data
        : { version: 1, providers: {}, ignoredEnvironmentProviders: [] };
    } catch {
      return { version: 1, providers: {}, ignoredEnvironmentProviders: [] };
    }
  }

  private async writeStoredFile(): Promise<void> {
    const temporaryPath = join(
      dirname(this.path),
      `.credentials-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(this.stored)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}

function encryptCredential(value: string): StoredCredential {
  return {
    ciphertext: safeStorage.encryptString(value).toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

function restoreOptional<T>(
  target: Partial<Record<CredentialProvider, T>>,
  provider: CredentialProvider,
  value: T | undefined,
): void {
  if (value == null) {
    delete target[provider];
  } else {
    target[provider] = value;
  }
}
