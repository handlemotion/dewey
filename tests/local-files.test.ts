import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalFileReader } from "../src/main/tools/local-files";

describe("Malcolm local file reader", () => {
  it("reads only a bounded line range in the selected workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dewey-files-"));
    await writeFile(join(root, "notes.md"), "one\ntwo\nthree\nfour\n");
    const read = createLocalFileReader(() => root);
    await expect(read({ path: "notes.md", startLine: 2, endLine: 3 })).resolves.toMatchObject({
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
    });
  });

  it("rejects traversal, unsupported files, and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dewey-root-"));
    const outside = await mkdtemp(join(tmpdir(), "dewey-outside-"));
    await writeFile(join(outside, "secret.txt"), "outside");
    await writeFile(join(root, "binary.exe"), "no");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    const read = createLocalFileReader(() => root);

    await expect(read({ path: "../secret.txt", startLine: 1 })).rejects.toThrow(
      "outside the selected workspace",
    );
    await expect(read({ path: "binary.exe", startLine: 1 })).rejects.toThrow("file type");
    await expect(read({ path: "linked.txt", startLine: 1 })).rejects.toThrow("resolves outside");
  });

  it("supports common source files and rejects invalid line windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "dewey-files-"));
    await writeFile(join(root, "worker.py"), "one\ntwo\nthree\n");
    const read = createLocalFileReader(() => root);

    await expect(read({ path: "worker.py", startLine: 2, endLine: 3 })).resolves.toMatchObject({
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
    });
    await expect(read({ path: "worker.py", startLine: 10 })).rejects.toThrow("startLine exceeds");
    await expect(read({ path: "worker.py", startLine: 3, endLine: 2 })).rejects.toThrow("endLine");
  });
});
