# Baldosas que abren apps (Claude Desktop y Windows Terminal) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la baldosa **Claude** (nueva) abra Claude Desktop en un chat nuevo y que la baldosa **Terminal** abra Windows Terminal con PowerShell 7 en la carpeta de usuario, eliminando la terminal integrada.

**Architecture:** Un lanzador en main (`app-launcher.ts`) con dependencias inyectadas (`openExternal`, `spawn`, entorno, reloj) y un canal IPC `apps:open` que lo invoca y cierra el panel; el registro de baldosas separa **vistas** del panel de **apps**. Después se borra todo lo de la terminal integrada (xterm + node-pty).

**Tech Stack:** Electron 45, TypeScript 6, React 19, zod 4, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-13-claude-chat-design.md`

## Global Constraints

- Claude: `claude://claude.ai/new`; si `openExternal` rechaza, `https://claude.ai/new`.
- Terminal: `wt.exe -w new -d "<home>" pwsh.exe -NoLogo` con `<home>` = `app.getPath('home')`; respaldos `pwsh.exe -NoLogo` → `powershell.exe -NoLogo` (con `cwd: <home>`, consola propia).
- `spawn` sin shell, `detached: true`, `stdio: 'ignore'`, `windowsHide: false`, `unref()`; entorno = el de main **sin** variables `NOTCH_*` ni `ELECTRON_*`.
- Al abrir con éxito: `intent: 'dismiss'` (el panel se cierra). Si nada abre: el panel sigue abierto y muestra "No se pudo abrir <app>" (decisión del constructor dentro de lo que el spec deja abierto).
- Clics repetidos de la misma app en menos de **1000 ms** se ignoran.
- Log: solo `apps:open` con `{ app, result }` (`desktop | browser | wt | pwsh | powershell | failed | ignored`); nunca rutas ni entorno.
- Pruebas: nunca abren Claude Desktop, el navegador ni una terminal reales (interruptor `NOTCH_APP_LAUNCH_LOG=1`, ignorado empaquetado, que registra en lugar de ejecutar).
- Orden de la fila: Terminal, Recordatorios, Sistema, Notas, Gmail, Revisiones, Claude; ninguna etiqueta cortada en ES ni EN.
- No modificar `eslint.config.mjs`. Commits solo con aprobación del usuario; sin push.

## Review Focus

1. **Carpeta de usuario con espacios** (`C:\Users\Ana María`) → llega como un único argumento de `-d`, sin comillas extra (Task 1).
2. **`wt.exe` presente pero falla al arrancar** (evento `error` tras `spawn`) → pasa al respaldo `pwsh`, no se queda colgado (Task 1).
3. **Variables de desarrollo del notch** (`NOTCH_USER_DATA_DIR`…) no llegan a la terminal del usuario (Task 1).
4. **Doble clic rápido en Claude o Terminal** → una sola app abierta y un solo cierre de panel (Task 1, Task 2).
5. **El panel se cerró antes de responder `apps:open`** (clic fuera durante el arranque) → sin error ni reapertura del panel (Task 2).

---

### Task 0: Verificación manual (usuario)

- [ ] Pedir al usuario que ejecute `start claude://claude.ai/new` (con Claude Desktop cerrado y luego abierto) y confirme que abre un **chat nuevo** en la sección Chat.
- [ ] Pedirle que ejecute `wt.exe -w new -d "%USERPROFILE%" pwsh.exe -NoLogo` y confirme ventana nueva de Windows Terminal con PowerShell 7 en `C:\Users\migue`.
- [ ] Si el enlace no abre un chat nuevo: **parar** y volver a hablar con el usuario.

### Task 1: Lanzador de apps

**Files:** Create `src/main/apps/app-launcher.ts`; Test `tests/unit/main/app-launcher.test.ts`.

**Interfaces — Produces:**
```ts
export type AppId = 'claude' | 'terminal'
export type LaunchResult = 'desktop' | 'browser' | 'wt' | 'pwsh' | 'powershell' | 'failed' | 'ignored'
export interface AppLauncherDeps {
  openExternal(url: string): Promise<void>
  /** Resolves true on the child's 'spawn' event, false on 'error'; detaches and unrefs on success. */
  trySpawn(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<boolean>
  homeDir: string
  env: NodeJS.ProcessEnv
  now(): number
}
export function createAppLauncher(deps: AppLauncherDeps): { open(app: AppId): Promise<LaunchResult> }
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv   // drops NOTCH_* and ELECTRON_*
export function nodeTrySpawn(): AppLauncherDeps['trySpawn']          // real child_process.spawn adapter, not unit-tested
```

- [ ] **Step 1: Pruebas que fallan** (`app-launcher.test.ts`, dependencias falsas):
  - `claude abre claude://claude.ai/new` → `openExternal` llamado una vez con `'claude://claude.ai/new'`; resultado `'desktop'`.
  - `claude cae al navegador si el protocolo falla` → primer `openExternal` rechaza; segundo con `'https://claude.ai/new'`; resultado `'browser'`; ambos rechazan → `'failed'`.
  - `terminal lanza wt en la carpeta de usuario` → `trySpawn('wt.exe', ['-w','new','-d','C:\\Users\\Ana María','pwsh.exe','-NoLogo'], { cwd: 'C:\\Users\\Ana María', env })`; resultado `'wt'` (Review Focus 1).
  - `terminal cae a pwsh y luego a powershell` → `wt.exe` → false ⇒ `trySpawn('pwsh.exe', ['-NoLogo'], …)` → `'pwsh'`; ambos false ⇒ `'powershell.exe'`; los tres false ⇒ `'failed'` (Review Focus 2).
  - `el entorno no lleva NOTCH_ ni ELECTRON_` → `env` con `NOTCH_USER_DATA_DIR`, `ELECTRON_RUN_AS_NODE` y `PATH`: lo recibido por `trySpawn` solo tiene `PATH` (Review Focus 3).
  - `ignora un segundo clic de la misma app en < 1000 ms` → `now` 0 y luego 999: el segundo devuelve `'ignored'` sin llamar a nada; a 1000 ms vuelve a abrir; una app distinta no se ignora (Review Focus 4).
- [ ] **Step 2:** `npx vitest run tests/unit/main/app-launcher.test.ts` → FAIL (módulo inexistente).
- [ ] **Step 3:** Implementar `createAppLauncher`, `cleanEnv` y `nodeTrySpawn` en `app-launcher.ts`. `nodeTrySpawn`: `spawn(file, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: false, shell: false })`, resuelve con el primero de `spawn` (→ `child.unref()`, `true`) o `error` (→ `false`).
- [ ] **Step 4:** el mismo comando → PASS.

### Task 2: Baldosas Claude y Terminal como apps

**Files:** Modify `src/shared/integrations/registry.ts`, `src/shared/ipc/channels.ts`, `src/shared/ipc/contract.ts`, `src/main/index.ts` (registro IPC e interruptor), `src/renderer/notch/IntegrationRow.tsx`, `src/shared/i18n/messages.ts`, el `preload` del notch si expone canales a mano; Test `tests/unit/shared/ipc-contract.test.ts`, `tests/unit/main/register-ipc.test.ts`, prueba del registro en `tests/unit/shared/` (nueva `integrations-registry.test.ts`).

**Interfaces — Consumes:** Task 1. **Produces:**
```ts
// registry.ts
export const viewIntegrationIds = ['reminders', 'system', 'notes', 'gmail', 'reviews'] as const
export type IntegrationId = (typeof viewIntegrationIds)[number]          // views only (state.ts keeps using it)
export const appIds = ['terminal', 'claude'] as const                   // same AppId as Task 1
export type Tile = { kind: 'view'; id: IntegrationId; labelKey: MessageKey } | { kind: 'app'; id: AppId; labelKey: MessageKey }
export const tiles: readonly Tile[]   // terminal, reminders, system, notes, gmail, reviews, claude
// contract: 'apps:open': { input: z.strictObject({ app: z.enum(appIds) }), output: z.strictObject({ ok: z.boolean() }) }
// channel name constant: apps.open = 'apps:open'; guard fromNotch
```

- [ ] **Step 1: Pruebas que fallan:**
  - `ipc-contract`: `apps:open` acepta `{ app: 'claude' }` y `{ app: 'terminal' }`, rechaza `{ app: 'notes' }` y claves extra; `notch:open-integration` ya no acepta `'terminal'`.
  - `register-ipc`: `apps:open` desde Control Center se rechaza (guard).
  - `integrations-registry`: `tiles.map(t => t.id)` es exactamente `['terminal','reminders','system','notes','gmail','reviews','claude']` y `kind` es `'app'` solo para `terminal` y `claude`.
- [ ] **Step 2:** `npx vitest run tests/unit/shared/ipc-contract.test.ts tests/unit/main/register-ipc.test.ts tests/unit/shared/integrations-registry.test.ts` → FAIL.
- [ ] **Step 3:** Implementar contrato, registro y el manejador en `index.ts`: `launcher.open(app)`, log `{ app, result }`, y si el resultado no es `failed` ni `ignored`, despachar el mismo evento que hoy usa `notch:request` para `dismiss`; devolver `{ ok: result !== 'failed' }`. Con el panel ya cerrado, `dismiss` no cambia nada (Review Focus 5: prueba en `notch-state` "dismiss con `expanded: false` deja el estado igual", si no existe ya). Con `NOTCH_APP_LAUNCH_LOG === '1'` y no empaquetado, las dependencias de Task 1 se sustituyen por unas que añaden `{ kind: 'external' | 'spawn', file, args }` a `globalThis.__notchAppLaunches` y devuelven éxito.
- [ ] **Step 4:** `IntegrationRow` recorre `tiles`: vistas → `openIntegration({ id })` como hoy; apps → `window.notch.apps.open({ app })` y, si `ok` es false, una línea "No se pudo abrir {app}" bajo la fila durante 4 s (`role="status"`). Iconos: `SquareTerminal` (Terminal), `MessagesSquare` (Claude). i18n ES/EN: `integration.claude` "Claude"; `apps.openFailed` "No se pudo abrir {app}" / "Couldn't open {app}". Quitar la carga anticipada de la terminal (`loadTerminal`).
- [ ] **Step 5:** `npm run typecheck && npm run lint && npm test` → PASS.

### Task 3: Eliminar la terminal integrada

**Files:**
- Delete: `src/main/terminal/` (`shell-resolver.ts`, `terminal-session.ts`), `src/shared/terminal/chunk-input.ts`, `src/renderer/notch/{TerminalView,TerminalBoundary}.tsx`, `terminal-loader.ts`, `terminal-theme.ts`, `tests/e2e/terminal.spec.ts`, `tests/unit/main/{terminal-session,shell-resolver}.test.ts`, `tests/unit/shared/chunk-input.test.ts`.
- Modify: `src/shared/notch/state.ts` y `geometry.ts` (modo/vista `terminal`, `CAPSULE_SIZES.terminal`, orden de redimensionado y ancho máximo de ventana), `src/shared/ipc/{channels,contract}.ts` (canales `terminal:*`), `src/main/index.ts` (sesión pty, `pty.spawn`, manejadores), `src/renderer/notch/{NotchApp.tsx,motion.ts}` (vista y excepción de Esc), `src/main/system/win32-system.ts` (solo si importa algo borrado), `src/shared/i18n/messages.ts` (claves sin uso), `package.json`/`package-lock.json` (quitar `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` con `npm uninstall`), `electron-builder.yml` (quitar `asarUnpack` de node-pty y su comentario; `npmRebuild: false` se queda por koffi).
- Test: casos de terminal en `notch-state`, `notch-geometry`, `notch-controller`, `register-ipc`, `ipc-contract`, `system-monitor`, `app.spec`, `claude.spec`, `reminders.spec`.

- [ ] **Step 1:** `grep -rn -i "terminal\|pty\|xterm" src tests electron-builder.yml package.json` y anotar cada aparición; tras esta tarea solo quedan la baldosa/app `terminal` y el lanzador.
- [ ] **Step 2:** Borrar y ajustar. Donde una prueba usaba la terminal como "un panel cualquiera" (p. ej. `claude.spec`, `reminders.spec`), usar Notas. En `geometry`, el ancho de ventana se recalcula: el más ancho pasa a ser 560/520 (el que salga de `CAPSULE_SIZES`); la prueba de geometría lo fija.
- [ ] **Step 3:** el grep del Step 1 → solo las apariciones esperadas.
- [ ] **Step 4:** `npm run typecheck && npm run lint && npm test && npm run build` → PASS, y ningún `node-pty` en `node_modules` ni en `out/`.

### Task 4: Fila de 7 baldosas, E2E y documentación

**Files:** Create `tests/e2e/apps.spec.ts`; Modify `src/renderer/notch/IntegrationRow.tsx` (relleno/tamaño para 7, medido), `tests/e2e/app.spec.ts`, `DESIGN.md` (fila de 7; terminal y Claude abren apps; sin terminal integrada), el PRD (dónde esté la lista de hitos: terminal integrada retirada), `docs/superpowers/specs/2026-11-13-claude-chat-design.md` (solo si la implementación se aparta, con nota "Cambio").

- [ ] **Step 1:** `apps.spec.ts` (app lanzada con `NOTCH_APP_LAUNCH_LOG=1`):
  - `la baldosa Claude abre el enlace de Claude Desktop y cierra el panel` → `__notchAppLaunches` termina en `{ kind: 'external', file: 'claude://claude.ai/new' }` y el modo deja de ser `expanded`.
  - `la baldosa Terminal lanza Windows Terminal en la carpeta de usuario` → última entrada `{ kind: 'spawn', file: 'wt.exe', args: ['-w','new','-d', <home>,'pwsh.exe','-NoLogo'] }` con `<home>` leído con `app.getPath('home')` en `electronApp.evaluate`.
  - `doble clic en Claude abre una sola vez` → dos clics seguidos: una sola entrada.
- [ ] **Step 2:** En `app.spec`, la prueba de "ninguna etiqueta cortada" cubre las 7 baldosas en ES y EN; si falla, ajustar `IntegrationRow` (relleno horizontal, `gap` o ancho del panel `home`) y actualizar su comentario de medida con los px medidos.
- [ ] **Step 3:** `npm run build && npm run test:e2e` → PASS. Captura `tests/e2e/__screenshots__/integration-row-7-es.png` de la ventana del notch.
- [ ] **Step 4:** `DESIGN.md` y PRD actualizados.

### Task 5: Revisión final

- [ ] Revisión de la rama completa con subagente (`ecc:code-reviewer`) contra el spec y este plan; corregir lo confirmado.
- [ ] `npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e` → PASS.
- [ ] Manual (usuario): las dos baldosas con Claude Desktop y Windows Terminal reales.
