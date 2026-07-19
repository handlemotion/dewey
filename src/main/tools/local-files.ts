import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { z } from "zod";

const allowedExtensions = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".kts",
  ".lua",
  ".md",
  ".mdx",
  ".php",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml",
]);

export const readLocalFileInputSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    startLine: z.number().int().min(1).max(1_000_000).default(1),
    endLine: z.number().int().min(1).max(1_000_000).optional(),
  })
  .refine((input) => input.endLine == null || input.endLine >= input.startLine, {
    message: "endLine must be greater than or equal to startLine.",
  });

export function createLocalFileReader(getWorkspaceRoot: () => string | undefined) {
  return async (input: z.infer<typeof readLocalFileInputSchema>) => {
    const parsed = readLocalFileInputSchema.parse(input);
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot == null) {
      throw new Error("Select a workspace before asking Malcolm to read local files.");
    }
    const root = resolve(workspaceRoot);
    const path = resolve(root, parsed.path);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("Path is outside the selected workspace.");
    }
    if (!allowedExtensions.has(extname(path).toLowerCase())) {
      throw new Error("This file type is not available to Malcolm.");
    }
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
    if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error("Path resolves outside the selected workspace.");
    }
    const text = await readFile(canonicalPath, "utf8");
    if (text.length > 500_000) {
      throw new Error("File is too large. Select a smaller relevant file.");
    }
    const lines = text.split("\n");
    if (parsed.startLine > lines.length) {
      throw new Error(`startLine exceeds the file's ${lines.length} lines.`);
    }
    const start = parsed.startLine - 1;
    const end = parsed.endLine ?? Math.min(lines.length, parsed.startLine + 999);
    return {
      path: parsed.path,
      startLine: parsed.startLine,
      endLine: Math.min(end, lines.length),
      content: lines.slice(start, end).join("\n"),
    };
  };
}
