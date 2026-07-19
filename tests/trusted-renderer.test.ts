import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "../src/main/security/trusted-renderer";

describe("trusted renderer URL", () => {
  const expectedFilePath = resolve("fixtures", "Dewey", "renderer", "index.html");

  it("accepts only the exact packaged renderer file", () => {
    expect(
      isTrustedRendererUrl({
        url: pathToFileURL(expectedFilePath).href,
        packaged: true,
        expectedFilePath,
      }),
    ).toBe(true);
    expect(
      isTrustedRendererUrl({
        url: pathToFileURL(join(dirname(expectedFilePath), "other.html")).href,
        packaged: true,
        expectedFilePath,
      }),
    ).toBe(false);
    expect(
      isTrustedRendererUrl({
        url: "https://example.com",
        packaged: true,
        expectedFilePath,
      }),
    ).toBe(false);
  });

  it("accepts the configured development origin without trusting lookalikes", () => {
    expect(
      isTrustedRendererUrl({
        url: "http://localhost:5173/settings",
        packaged: false,
        expectedFilePath,
        developmentUrl: "http://localhost:5173/",
      }),
    ).toBe(true);
    expect(
      isTrustedRendererUrl({
        url: "http://localhost.evil.test:5173/",
        packaged: false,
        expectedFilePath,
        developmentUrl: "http://localhost:5173/",
      }),
    ).toBe(false);
  });
});
