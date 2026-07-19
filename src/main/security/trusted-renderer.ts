import { fileURLToPath } from "node:url";

export function isTrustedRendererUrl(input: {
  url: string;
  packaged: boolean;
  expectedFilePath: string;
  developmentUrl?: string;
}): boolean {
  if (input.packaged) {
    if (!input.url.startsWith("file://")) return false;
    try {
      return fileURLToPath(input.url) === input.expectedFilePath;
    } catch {
      return false;
    }
  }

  if (input.developmentUrl == null) return false;
  try {
    return new URL(input.url).origin === new URL(input.developmentUrl).origin;
  } catch {
    return false;
  }
}
