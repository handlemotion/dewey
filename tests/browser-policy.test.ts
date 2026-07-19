import { describe, expect, it } from "vitest";
import { BrowserTools } from "../src/main/tools/browser";

describe("browser action risk policy", () => {
  const browser = new BrowserTools();

  it("requires cost visibility for financial actions", () => {
    expect(() =>
      browser.propose(
        {
          url: "https://example.com/checkout",
          instruction: "Place the order",
          target: "Checkout button",
          expectedEffect: "Purchase the selected item",
          risk: "write",
          costDescription: null,
          irreversibility: null,
        },
        "task-1",
      ),
    ).toThrow("cost description");

    expect(
      browser.propose(
        {
          url: "https://example.com/checkout",
          instruction: "Place the order",
          target: "Checkout button",
          expectedEffect: "Purchase the selected item",
          risk: "financial",
          costDescription: "$24.00 plus displayed tax",
          irreversibility: null,
        },
        "task-1",
      ),
    ).toMatchObject({
      risk: "financial",
      costDescription: "$24.00 plus displayed tax",
    });
  });

  it("requires explicit irreversibility for destructive actions", () => {
    expect(() =>
      browser.propose(
        {
          url: "https://example.com/settings",
          instruction: "Delete the account",
          target: "Account",
          expectedEffect: "Permanently remove the account",
          risk: "write",
          costDescription: null,
          irreversibility: null,
        },
        "task-2",
      ),
    ).toThrow("irreversibility");
  });

  it("rejects non-web URLs and embedded credentials", () => {
    const proposal = {
      instruction: "Submit the form",
      target: "Form",
      expectedEffect: "Save the form",
      risk: "write" as const,
      costDescription: null,
      irreversibility: null,
    };
    expect(() =>
      browser.propose({ ...proposal, url: "file:///tmp/private.html" }, "task-3"),
    ).toThrow();
    expect(() =>
      browser.propose({ ...proposal, url: "https://user:secret@example.com" }, "task-3"),
    ).toThrow();
  });
});
