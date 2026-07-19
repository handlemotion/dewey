import { describe, expect, it } from "vitest";
import { availableRealtimeTools } from "../src/main/tools/realtime-tools";

describe("realtime tool availability", () => {
  it("exposes only configured provider capabilities", () => {
    expect(
      Object.keys(
        availableRealtimeTools({
          exaConfigured: false,
          firecrawlConfigured: false,
        }),
      ),
    ).toEqual(["proposeMalcolm"]);
    expect(
      Object.keys(
        availableRealtimeTools({
          exaConfigured: true,
          firecrawlConfigured: false,
        }),
      ),
    ).toEqual(["searchWeb", "proposeMalcolm"]);
    expect(
      Object.keys(
        availableRealtimeTools({
          exaConfigured: false,
          firecrawlConfigured: true,
        }),
      ),
    ).toEqual(["inspectBrowser", "proposeBrowserAction", "proposeMalcolm"]);
  });
});
