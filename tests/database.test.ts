import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DeweyStore } from "../src/main/storage/database";
import type { ConsequentialAction, MalcolmTask } from "../src/shared/contracts";

async function databasePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "dewey-db-")), "dewey.sqlite");
}

describe("DeweyStore durability", () => {
  it("migrates a fresh database idempotently", async () => {
    const path = await databasePath();
    new DeweyStore(path).close();
    new DeweyStore(path).close();

    const sqlite = new Database(path, { readonly: true });
    expect(sqlite.pragma("user_version", { simple: true })).toBe(3);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "conversations",
        "messages",
        "citations",
        "tool_calls",
        "malcolm_tasks",
        "approvals",
        "usage_events",
        "provider_metadata",
        "browser_profiles",
      ]),
    );
    sqlite.close();
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("upgrades an existing v2 approval ledger without losing pending actions", async () => {
    const path = await databasePath();
    new DeweyStore(path).close();

    const sqlite = new Database(path);
    sqlite.exec(`
      CREATE TABLE approvals_v2 (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, arguments_json TEXT NOT NULL, target TEXT NOT NULL,
        expected_effect TEXT NOT NULL, risk TEXT NOT NULL, originating_task_id TEXT NOT NULL,
        expires_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT, result_json TEXT, error_text TEXT
      );
      DROP TABLE approvals;
      ALTER TABLE approvals_v2 RENAME TO approvals;
      CREATE INDEX approvals_status_idx ON approvals(status, expires_at);
      PRAGMA user_version = 2;
    `);
    const createdAt = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO approvals (
          id, tool, arguments_json, target, expected_effect, risk, originating_task_id,
          expires_at, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "existing-action",
        "executeApprovedBrowserAction",
        '{"url":"https://example.com"}',
        "example.com",
        "Submit the existing form",
        "write",
        "existing-task",
        new Date(Date.now() + 60_000).toISOString(),
        "pending",
        createdAt,
        createdAt,
      );
    sqlite.close();

    const upgraded = new DeweyStore(path);
    expect(upgraded.listApprovals()).toContainEqual(
      expect.objectContaining({
        id: "existing-action",
        status: "pending",
        target: "example.com",
      }),
    );
    upgraded.close();

    const verified = new Database(path, { readonly: true });
    expect(verified.pragma("user_version", { simple: true })).toBe(3);
    const columns = verified
      .prepare("PRAGMA table_info(approvals)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining(["cost_description", "irreversibility"]));
    verified.close();
  });

  it("persists citations and reconciles interrupted work on restart", async () => {
    const path = await databasePath();
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const task: MalcolmTask = {
      id: crypto.randomUUID(),
      objective: "Inspect the selected evidence",
      reasonForDelegation: "The work needs an isolated context",
      expectedOutput: "A concise report",
      status: "running",
      reasoningLevel: "deep",
      model: "gpt-5.6-terra",
      createdAt,
      updatedAt: createdAt,
    };
    const approval: ConsequentialAction = {
      id: crypto.randomUUID(),
      tool: "executeApprovedBrowserAction",
      arguments: { url: "https://example.com", instruction: "Submit", target: "form" },
      target: "example.com form",
      expectedEffect: "Submit the form",
      risk: "write",
      originatingTaskId: task.id,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      status: "pending",
      createdAt,
    };

    let store = new DeweyStore(path);
    store.saveTask(task);
    store.startToolCall({
      id: "tool-running",
      tool: "searchWeb",
      risk: "read",
      arguments: { query: "durability" },
    });
    store.saveApproval(approval);
    store.appendMessage({
      id: crypto.randomUUID(),
      role: "dewey",
      text: "Grounded answer",
      createdAt,
      citations: [
        {
          id: "source-1",
          title: "Primary source",
          url: "https://example.com/source",
          sourceQuality: "primary",
        },
      ],
    });
    store.close();

    store = new DeweyStore(path);
    expect(store.getTask(task.id)).toMatchObject({
      status: "failed",
      progress: "Interrupted when Dewey closed",
    });
    expect(store.listApprovals()).toContainEqual(
      expect.objectContaining({ id: approval.id, status: "expired" }),
    );
    expect(store.listMessages()).toContainEqual(
      expect.objectContaining({
        text: "Grounded answer",
        citations: [
          expect.objectContaining({
            title: "Primary source",
            url: "https://example.com/source",
          }),
        ],
      }),
    );
    store.close();

    const sqlite = new Database(path, { readonly: true });
    expect(
      (
        sqlite.prepare("SELECT status FROM tool_calls WHERE id = ?").get("tool-running") as {
          status: string;
        }
      ).status,
    ).toBe("failed");
    sqlite.close();
  });

  it("requires browser profiles to be explicitly active", async () => {
    const store = new DeweyStore(await databasePath());
    expect(() => store.touchBrowserProfile("personal")).toThrow("not active");
    expect(store.saveBrowserProfile("personal")).toMatchObject({
      name: "personal",
      persistent: true,
    });
    expect(store.touchBrowserProfile("personal").name).toBe("personal");
    store.revokeBrowserProfile("personal");
    expect(() => store.touchBrowserProfile("personal")).toThrow("not active");
    store.close();
  });

  it("falls back safely when persisted settings are malformed", async () => {
    const path = await databasePath();
    const store = new DeweyStore(path);
    store.close();
    if (process.platform !== "win32") await chmod(path, 0o600);

    const sqlite = new Database(path);
    sqlite
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('app', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run('{"malcolmDelegationMode":"run-without-limits"}', new Date().toISOString());
    sqlite.close();

    const reopened = new DeweyStore(path);
    expect(
      reopened.getSettings({
        openaiConfigured: false,
        exaConfigured: false,
        firecrawlConfigured: false,
      }),
    ).toMatchObject({
      malcolmDelegationMode: "always-ask",
      malcolmAutomaticCeilingUsd: 1,
    });
    reopened.close();
  });
});
