import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

function contentSecurityPolicyPlugin(): Plugin {
  let command: "build" | "serve" = "build";
  return {
    name: "dewey-content-security-policy",
    configResolved(config) {
      command = config.command;
    },
    transformIndexHtml: {
      order: "pre",
      handler() {
        const scriptSource = command === "serve" ? "'self' 'unsafe-inline'" : "'self'";
        return [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: `default-src 'self'; connect-src 'self' wss://api.openai.com; media-src 'self' blob:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src ${scriptSource};`,
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts"),
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [contentSecurityPolicyPlugin(), react()],
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
