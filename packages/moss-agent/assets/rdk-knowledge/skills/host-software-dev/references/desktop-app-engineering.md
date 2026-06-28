# Building RDK Studio Itself — Electron / React / Vite / Node / TypeScript

> For engineers working on RDK Studio's **own source**, not users driving the app.
> Sources: official framework docs — Electron (process-model, preload, IPC, contextBridge), Vite (HMR, env), TypeScript (compiler options, tsconfig), Node (ESM, errors), electron-builder (code signing). Each error row cites the doc.

## Table of contents

- [1. Runtime boundaries — locate the layer first](#1-runtime-boundaries--locate-the-layer-first)
- [2. The debugging loop](#2-the-debugging-loop)
- [3. Electron IPC contract](#3-electron-ipc-contract)
- [4. Frontend build contract](#4-frontend-build-contract)
- [5. Error → cause → fix table](#5-error--cause--fix-table)
- [6. Official docs](#6-official-docs)

---

## 1. Runtime boundaries — locate the layer first

Desktop/frontend bugs are almost always a **layer** problem. Before changing code, identify where the failing code runs:

- **Browser / renderer** — UI, React tree, DOM. No Node APIs here unless deliberately bridged.
- **Electron main process** — windows, app lifecycle, native integration, IPC handlers.
- **Preload script** — the *only* sanctioned bridge between Node-capable main and the renderer. Keep it narrow, typed, and reviewed as a security boundary.
- **Node backend** — any local server/service.
- **Build tool (Vite) / test runner** — transforms and serves; not the runtime.

Rule: **do not reach Node APIs from a browser/renderer path** unless the app exposes a narrow preload bridge. Treat Vite dev-server behavior, `tsc` typechecking, Electron packaging, and backend runtime as **separate failure surfaces**.

## 2. The debugging loop

1. Reproduce the smallest failing path; capture the **exact** console / terminal / build error from the layer that failed.
2. For **Electron**, check main-process logs, preload exposure, renderer console, and registered IPC handlers *separately*.
3. For **React/Vite**, separate render bugs from dev-server/HMR bugs. Vite transforms TypeScript but does **not** replace `tsc --noEmit` — run the typechecker explicitly.
4. For **packaging/signing**, verify the local build output first, then signing identity, certificate variables, entitlements, and notarization.

## 3. Electron IPC contract

1. Register `ipcMain.handle(channel, handler)` in the main process **before** any renderer calls `ipcRenderer.invoke(channel, ...)`.
2. Expose only a **typed, minimal API** through `contextBridge.exposeInMainWorld`; never expose raw `ipcRenderer` or unrestricted channel names.
3. Validate payloads at the main-process boundary; return **structured-clone-serializable** values only (no functions, no class instances, no DOM nodes).
4. Centralize channel names so preload, renderer, and main cannot drift silently.

## 4. Frontend build contract

1. Run the narrow command that matches the failure: `tsc --noEmit` for types, `vite` / `npm run dev` for the dev server, the production build for bundling, `electron-builder` for desktop artifacts.
2. Confirm the active **Node version**, the package-manager **lockfile**, the workspace root, and the **resolved** package version before changing source.
3. Vite client env vars must use the project's public prefix (commonly `VITE_`); secrets stay in backend/main-process code, never shipped to the renderer.
4. Fix TypeScript errors at the declaration or call boundary; do not hide contract problems with unchecked casts.

## 5. Error → cause → fix table

| Error signature | Cause | Fix |
|---|---|---|
| `require is not defined` / `Cannot find module ... in preload` / `process is not defined` / `module is not defined` | Preload/renderer sandbox mismatch — Node code in a non-Node context | Keep Node-only code in main or preload; expose a narrow API via `contextBridge`; verify the `BrowserWindow.webPreferences.preload` path actually loads. ([Electron preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)) |
| `No handler registered` / `Error invoking remote method` / `An object could not be cloned` / `Unable to deserialize cloned data` | IPC contract drift | Register `ipcMain.handle` before renderer `invoke`; match channel names exactly; return structured-clone-serializable values. ([Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)) |
| `[vite] ... failed to connect` / `WebSocket connection ... failed/closed` / `hmr update ... failed` | Vite HMR WebSocket failure | Check dev-server host/port, reverse proxy or Electron renderer origin, `server.hmr` settings, and browser network errors **before** touching React state. ([Vite HMR](https://vite.dev/guide/features.html#hot-module-replacement)) |
| `TS2322 / TS2307 / TS2741 / TS7006` / `Type ... is not assignable` / `Cannot find module ... or its type declarations` | TypeScript contract failure | `tsc --noEmit -p <tsconfig>` at the package boundary; fix the first real diagnostic at declarations/import paths, not with casts. ([TS compiler options](https://www.typescriptlang.org/docs/handbook/compiler-options.html)) |
| `TS18003` / `No inputs were found in config file` | **Config** error, not a type error — tsconfig matched no input files | Check `include`/`files` globs, `rootDir`, workspace root so they hit the `.ts` sources. ([tsconfig include](https://www.typescriptlang.org/tsconfig/#include)) |
| `CSC_LINK` / `No identity found` / `codesign ... failed` / `item could not be found in the keychain` / `notarization ... failed` / `Developer ID Application` | Packaging signing failure | Verify certificate/keychain access or CI signing vars; confirm **unsigned** packaging works first; then check electron-builder signing & notarization for the target OS. ([electron-builder code signing](https://www.electron.build/code-signing.html)) |
| `EADDRINUSE` / `listen EADDRINUSE` / `address already in use` / `port N is already in use` | Dev-server/HTTP port held by a leftover process — usually not a code bug | Find the holder (`lsof -nP -iTCP:<port> -sTCP:LISTEN` on macOS/Linux, `netstat -ano \| findstr :<port>` on Windows), stop it, restart, or use another port. ([Node system errors](https://nodejs.org/api/errors.html#common-system-errors)) |
| `ERR_MODULE_NOT_FOUND` / `Cannot find module ... imported from` / `ERR_UNSUPPORTED_DIR_IMPORT` / `Did you mean to import ....js` | Runtime ESM resolution (distinct from a TS compile error) | In `"type":"module"` / NodeNext projects, relative imports need an explicit `.js` extension even from `.ts` sources; directory imports need an explicit index file; path/case must match disk. Fix the specifier, don't switch module systems. ([Node ESM](https://nodejs.org/api/esm.html#mandatory-file-extensions)) |

## 6. Official docs

- Electron: [Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) · [Preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload) · [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge) · [IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) · [Code Signing](https://www.electron.build/code-signing.html)
- React: [Learn](https://react.dev/learn) · [Hooks](https://react.dev/reference/react/hooks) · [createRoot](https://react.dev/reference/react-dom/client/createRoot)
- Vite: [Getting Started](https://vite.dev/guide/) · [HMR](https://vite.dev/guide/features.html#hot-module-replacement) · [TypeScript](https://vite.dev/guide/features.html#typescript) · [Env & Mode](https://vite.dev/guide/env-and-mode)
- TypeScript: [Compiler Options](https://www.typescriptlang.org/docs/handbook/compiler-options.html) · [TSConfig](https://www.typescriptlang.org/tsconfig/) · [Everyday Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)
- Node.js: [HTTP](https://nodejs.org/api/http.html) · [Streams](https://nodejs.org/api/stream.html) · [child_process](https://nodejs.org/api/child_process.html) · [Test Runner](https://nodejs.org/api/test.html) · [ESM](https://nodejs.org/api/esm.html)
