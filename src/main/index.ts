import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, session, shell, type WebContents } from "electron";
import { AppController } from "./controller";
import { CredentialVault } from "./credentials";
import { loadEnvironment } from "./env";
import { registerIpc } from "./ipc";
import { isTrustedRendererUrl } from "./security/trusted-renderer";
import { DeweyStore } from "./storage/database";

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let store: DeweyStore | undefined;
let controller: AppController | undefined;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(moduleDirectory, "../renderer/index.html");

async function createWindow(): Promise<void> {
  if (controller == null) throw new Error("Dewey has not finished initializing.");

  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#11120f",
    show: false,
    webPreferences: {
      preload: join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  controller.attachWindow(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL != null) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(rendererPath);
  }
  window.once("ready-to-show", () => window.show());
}

async function initialize(): Promise<void> {
  const env = loadEnvironment();
  const credentialVault = new CredentialVault(join(app.getPath("userData"), "credentials.v1.json"));
  await credentialVault.initialize(env);
  store = new DeweyStore(join(app.getPath("userData"), "dewey.db"));
  controller = new AppController(
    store,
    credentialVault,
    async () => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      const result =
        focusedWindow == null
          ? await dialog.showOpenDialog({
              title: "Select the workspace Malcolm may read",
              properties: ["openDirectory", "createDirectory"],
            })
          : await dialog.showOpenDialog(focusedWindow, {
              title: "Select the workspace Malcolm may read",
              properties: ["openDirectory", "createDirectory"],
            });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async (url) => shell.openExternal(url),
  );
  registerIpc(controller);

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) =>
      isTrustedRenderer(webContents, details.requestingUrl) &&
      ((permission === "media" && details.mediaType === "audio") ||
        (permission as string) === "speaker-selection"),
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl =
        "requestingUrl" in details && typeof details.requestingUrl === "string"
          ? details.requestingUrl
          : webContents.getURL();
      const trusted = isTrustedRenderer(webContents, requestingUrl);
      const microphoneOnly =
        permission === "media" &&
        "mediaTypes" in details &&
        details.mediaTypes?.length === 1 &&
        details.mediaTypes[0] === "audio";
      callback(trusted && (microphoneOnly || permission === "speaker-selection"));
    },
  );

  await createWindow();
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window == null) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

void app
  .whenReady()
  .then(initialize)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Dewey could not start", message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  store?.close();
});

function isTrustedRenderer(webContents: WebContents | null, requestingUrl?: string): boolean {
  if (webContents == null) return false;
  return isTrustedRendererUrl({
    url: requestingUrl ?? webContents.getURL(),
    packaged: app.isPackaged,
    expectedFilePath: rendererPath,
    ...(!app.isPackaged && process.env.ELECTRON_RENDERER_URL != null
      ? { developmentUrl: process.env.ELECTRON_RENDERER_URL }
      : {}),
  });
}
