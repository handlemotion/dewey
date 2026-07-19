import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const vitestPath = join(dirname(require.resolve("vitest")), "vitest.mjs");
const result = spawnSync(electronPath, [vitestPath, "run", "tests/database.test.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});

if (result.error != null) throw result.error;
process.exit(result.status ?? 1);
