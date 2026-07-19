import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MALCOLM_EXECUTION_LIMITS, malcolmOutputSchema } from "../src/main/agents/malcolm";

describe("Malcolm structured output", () => {
  it("uses an OpenAI strict-schema-compatible action contract", () => {
    const schema = z.toJSONSchema(malcolmOutputSchema) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["result", "proposedActions"]);
    expect(JSON.stringify(schema)).not.toContain('"propertyNames"');
    expect(JSON.stringify(schema)).not.toContain('"not"');

    const parsed = malcolmOutputSchema.parse({
      result: "Done",
      proposedActions: [
        {
          tool: "draftEmail",
          rationale: "A draft would help",
          arguments: '{"subject":"Hello"}',
          expectedEffect: "Prepare a draft without sending it",
          estimatedCost: null,
          risk: "draft",
        },
      ],
    });
    expect(parsed.proposedActions[0]?.arguments).toBe('{"subject":"Hello"}');
  });

  it("rejects malformed proposed action arguments at the agent boundary", () => {
    expect(() =>
      malcolmOutputSchema.parse({
        result: "Done",
        proposedActions: [
          {
            tool: "draftEmail",
            rationale: "A draft would help",
            arguments: "not-json",
            expectedEffect: "Prepare a draft without sending it",
            estimatedCost: null,
            risk: "draft",
          },
        ],
      }),
    ).toThrow();
  });

  it("uses explicit increasing execution envelopes", () => {
    expect(MALCOLM_EXECUTION_LIMITS.focused.maxSteps).toBeLessThan(
      MALCOLM_EXECUTION_LIMITS.deep.maxSteps,
    );
    expect(MALCOLM_EXECUTION_LIMITS.deep.maxSteps).toBeLessThan(
      MALCOLM_EXECUTION_LIMITS.maximum.maxSteps,
    );
    for (const limits of Object.values(MALCOLM_EXECUTION_LIMITS)) {
      expect(limits.maxSteps).toBeLessThanOrEqual(20);
      expect(limits.totalMs).toBeGreaterThan(limits.stepMs);
      expect(limits.totalMs).toBeGreaterThan(limits.researchWebMs);
    }
  });
});
