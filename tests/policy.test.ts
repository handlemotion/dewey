import { describe, expect, it } from "vitest";
import type { AppSettings } from "../src/shared/contracts";
import {
  approvalMatches,
  createTaskProposal,
  DEFAULT_SETTINGS,
  estimateMalcolmCost,
  initialMalcolmStatus,
  requiresApproval,
  shouldAskForMalcolm,
  TOOL_RISK,
} from "../src/shared/policy";

describe("tool approval policy", () => {
  it("requires immediate approval only for consequential risks", () => {
    expect(requiresApproval("read")).toBe(false);
    expect(requiresApproval("draft")).toBe(false);
    expect(requiresApproval("write")).toBe(true);
    expect(requiresApproval("financial")).toBe(true);
    expect(requiresApproval("destructive")).toBe(true);
    expect(TOOL_RISK.executeApprovedBrowserAction).toBe("write");
    expect(Object.values(TOOL_RISK).every((risk) => risk.length > 0)).toBe(true);
  });

  it("binds approval to the exact tool and arguments", () => {
    const stored = {
      tool: "executeApprovedBrowserAction",
      arguments: { url: "https://example.com", form: { name: "Rodrigo", count: 2 } },
    };
    expect(
      approvalMatches(stored, {
        tool: stored.tool,
        arguments: { form: { count: 2, name: "Rodrigo" }, url: "https://example.com" },
      }),
    ).toBe(true);
    expect(
      approvalMatches(stored, {
        tool: stored.tool,
        arguments: { url: "https://example.com", form: { name: "Rodrigo", count: 3 } },
      }),
    ).toBe(false);
    expect(
      approvalMatches(stored, {
        tool: "anotherTool",
        arguments: stored.arguments,
      }),
    ).toBe(false);
  });
});

describe("Malcolm delegation policy", () => {
  const settings = (patch: Partial<AppSettings>): AppSettings => ({
    ...DEFAULT_SETTINGS,
    ...patch,
  });

  it("defaults to asking and respects configured ceilings", () => {
    expect(shouldAskForMalcolm(settings({}), 0.01)).toBe(true);
    expect(
      shouldAskForMalcolm(settings({ malcolmDelegationMode: "automatic-within-limits" }), 0.5),
    ).toBe(false);
    expect(
      shouldAskForMalcolm(settings({ malcolmDelegationMode: "automatic-within-limits" }), 1.01),
    ).toBe(true);
  });

  it("creates a bounded, inspectable proposal", () => {
    const proposal = createTaskProposal(
      {
        objective: " Compare two architectures ",
        reasonForDelegation: " Several sources and a long repository ",
        expectedOutput: " A recommendation with tradeoffs ",
      },
      new Date("2026-07-19T12:00:00.000Z"),
      "task-1",
    );
    expect(proposal).toMatchObject({
      id: "task-1",
      objective: "Compare two architectures",
      status: "awaiting-approval",
      reasoningLevel: "deep",
      model: "gpt-5.6-terra",
    });
    expect(proposal.estimatedCost).toBeGreaterThan(0);
  });

  it("honors an explicit Malcolm request when automatic delegation is disabled", () => {
    const disabled = settings({ malcolmDelegationMode: "never" });
    expect(initialMalcolmStatus(disabled, 10, true)).toBe("running");
    expect(initialMalcolmStatus(disabled, 0.01, false)).toBe("cancelled");
  });

  it("prices Malcolm from actual cache-aware token usage", () => {
    const uncached = estimateMalcolmCost(1_000_000, 0);
    const cached = estimateMalcolmCost(1_000_000, 0, 1_000_000);
    const cacheWrite = estimateMalcolmCost(1_000_000, 0, 0, 1_000_000);
    expect(uncached).toBe(2.5);
    expect(cached).toBe(0.25);
    expect(cacheWrite).toBe(3.125);
  });
});
