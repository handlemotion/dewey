import { spawnSync } from "node:child_process";

const credentialMappings = {
  DEWEY_CSC_LINK: "CSC_LINK",
  DEWEY_CSC_KEY_PASSWORD: "CSC_KEY_PASSWORD",
  DEWEY_WIN_CSC_LINK: "WIN_CSC_LINK",
  DEWEY_WIN_CSC_KEY_PASSWORD: "WIN_CSC_KEY_PASSWORD",
  DEWEY_APPLE_API_KEY: "APPLE_API_KEY",
  DEWEY_APPLE_API_KEY_ID: "APPLE_API_KEY_ID",
  DEWEY_APPLE_API_ISSUER: "APPLE_API_ISSUER",
  DEWEY_APPLE_ID: "APPLE_ID",
  DEWEY_APPLE_APP_SPECIFIC_PASSWORD: "APPLE_APP_SPECIFIC_PASSWORD",
  DEWEY_APPLE_TEAM_ID: "APPLE_TEAM_ID",
};

const env = { ...process.env };

for (const [source, target] of Object.entries(credentialMappings)) {
  const wasProvided = Object.hasOwn(env, source);
  const value = env[source]?.trim();
  delete env[source];

  if (value) {
    env[target] = value;
  } else if (wasProvided) {
    delete env[target];
  }
}

if (!env.CSC_LINK && !env.WIN_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}

const isWindows = process.platform === "win32";
const command = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
const args = isWindows ? ["/d", "/s", "/c", "pnpm dist"] : ["dist"];
const result = spawnSync(command, args, {
  env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
