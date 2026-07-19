import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { app } from "electron";
import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  EXA_API_KEY: z.string().min(1).optional(),
  FIRECRAWL_API_KEY: z.string().min(1).optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnvironment(): AppEnv {
  for (const path of candidateEnvPaths()) {
    try {
      accessSync(path, constants.R_OK);
      config({ path, override: false, quiet: true });
    } catch {
      // A packaged app may rely on process-level credentials instead.
    }
  }

  return envSchema.parse(process.env);
}

function candidateEnvPaths(): string[] {
  const cwdPath = join(process.cwd(), ".env.local");
  if (!app.isPackaged) return [cwdPath];
  return [join(app.getPath("userData"), ".env.local")];
}
