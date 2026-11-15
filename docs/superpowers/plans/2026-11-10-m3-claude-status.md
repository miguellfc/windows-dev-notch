# M3 · Estado de Claude Code y permisos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El notch muestra el estado de cada sesión de Claude Code y permite permitir/denegar sus peticiones de permiso con un click.

**Architecture:** Hooks `http` de Claude Code → `ClaudeBridge` (main, `127.0.0.1` + token) → `SessionRegistry` y `PermissionBroker` (lógica pura) → `ClaudeService` agrega el estado y lo emite por IPC (`claude:state-changed`). El notch añade un modo `alert` y una vista `permission`; el Control Center instala los hooks.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Motion, zod 4, koffi, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-10-m3-claude-status-design.md` (+ `docs/spikes/m3-hooks-findings.md`).

## Global Constraints

- Solo `127.0.0.1`; puerto por defecto 47600 (*sustituido en la revisión final por un puerto aleatorio 49152–65535 persistido; ver la spec*); token 32 bytes aleatorios (`crypto.randomBytes`), hex.
- El token y el puerto viven en `userData/claude-bridge.json` (`{ version: 1, port, token: <safeStorage base64> }`), **nunca** en `settings.json` de la app ni en ninguna respuesta IPC.
- Cuerpo de hook ≤ 262 144 bytes; `content-type` JSON; solo `POST /hook`.
- Nunca registrar ni persistir `prompt`, `tool_input`, `tool_response`, `message`, `last_assistant_message`. La vista previa del comando: ≤ 2 000 caracteres, solo en memoria.
- Respuesta de decisión exacta: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}`. Sin decisión: 200 sin cuerpo.
- Solo "permitir una vez" y "denegar"; ningún atajo de teclado decide; `claude:decide` solo desde el webContents del notch; instalar/desinstalar/rotar solo desde el Control Center.
- Hooks propios marcados con header `x-notch-hook: 1`; `PermissionRequest` con `timeout: 3600`, el resto `timeout: 2`.
- Inactividad: 30 min sin eventos.
- Estilo Obsidian; colores de estado solo con significado y siempre con texto o icono; i18n ES/EN; escala 11/12.5/13/15 px.
- Sin commits por tarea (el usuario aprueba los commits al final). No modificar `eslint.config.mjs`. No push.

## Review Focus

1. **Claude responde en la app y la conexión del hook sigue abierta** → la alerta del notch desaparece y la respuesta HTTP se cierra con 200 vacío al recibir el siguiente evento de esa sesión (Task 3).
2. **Varias peticiones a la vez, de sesiones distintas** → cola por orden de llegada; decidir una no afecta a las otras (Task 3, Task 9).
3. **Notch cerrado con peticiones pendientes** → al salir, todas se liberan con 200 vacío; Claude sigue con su diálogo (Task 7).
4. **`settings.json` de Claude con BOM, JSON inválido o modificado por otra app** → el instalador no escribe y lo dice; nunca pierde hooks ajenos (Task 5).
5. **Comando enorme o con secuencias de control** en `tool_input` → la vista previa se acota y se muestra como texto plano (Task 1, Task 9).

---

### Task 1: Esquemas de eventos de hook

**Files:** Create `src/shared/claude/hook-events.ts`, `tests/unit/shared/claude-hook-events.test.ts`, `tests/unit/fixtures/claude-hooks/*.json` (eventos sintéticos con los campos reales de la prueba; valores inventados).

**Interfaces — Produces:** `parseHookEvent(raw: unknown): HookEvent | null`; `type HookEvent = { name: HookEventName; sessionId: string; cwd?: string; toolName?: string; notificationType?: string; preview?: string; reason?: string }`; `HookEventName` = `'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PermissionRequest' | 'PermissionDenied' | 'Notification' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'SessionEnd'`.

- [ ] Tests: cada fixture parsea; campos desconocidos se ignoran; falta `session_id` o `hook_event_name` desconocido → `null`; `preview` de `PermissionRequest` = comando/ruta de `tool_input` (`command`, `file_path`, `url`, o JSON compacto), recortado a 2 000 caracteres y sin caracteres de control salvo `\n`/`\t`; `HookEvent` nunca contiene `prompt`, `message`, `tool_response` ni `last_assistant_message`.
- [ ] RED → implementar con `z.looseObject` → GREEN.

### Task 2: SessionRegistry

**Files:** Create `src/main/claude/session-registry.ts`, `src/shared/claude/types.ts`; test `tests/unit/main/claude-session-registry.test.ts`.

**Interfaces — Produces:** `createSessionRegistry({ now: () => number, idleAfterMs = 1_800_000 })` → `{ apply(e: HookEvent): void; sessions(): ClaudeSession[]; tick(): boolean; dismiss(id: string): boolean }`; `ClaudeSession = { id: string; name: string; status: 'working' | 'waiting' | 'done' | 'error' | 'idle'; updatedAt: number }`.

- [ ] Tests con secuencias de la prueba: modo default (`UserPromptSubmit`→`PreToolUse`→`PermissionRequest`→`Notification`→`PostToolUse`→`Stop`) recorre working→waiting→working→done; `Notification: permission_prompt` sin `PermissionRequest` → waiting; `StopFailure` → error; `SessionEnd` elimina; `SubagentStop` tras `Stop` no la devuelve a working; 30 min sin eventos → idle (reloj falso; `tick()` devuelve `true` solo si algo cambió); `dismiss` solo funciona en idle; `name` = último segmento de `cwd` (o los 8 primeros caracteres del id si falta); orden por `updatedAt` descendente.
- [ ] RED → implementar → GREEN.

### Task 3: PermissionBroker

**Files:** Create `src/main/claude/permission-broker.ts`, test `tests/unit/main/claude-permission-broker.test.ts`.

**Interfaces — Produces:** `interface PendingReply { send(body: string | null): void; onClose(cb: () => void): void }`; `createPermissionBroker({ newId: () => string, now: () => number, sessionName: (id: string) => string, onChange: () => void })` → `{ hold(e: HookEvent, reply: PendingReply): void; decide(id: string, d: 'allow' | 'deny'): boolean; observe(e: HookEvent): void; releaseAll(): void; pending(): PendingPermission[] }`; `PendingPermission = { id; sessionId; sessionName; toolName; preview; receivedAt }`.

- [ ] Tests: `hold` encola por orden de llegada; `decide(id,'allow')` envía exactamente el JSON de Global Constraints y quita la entrada; id desconocido → `false` y nada enviado; `observe` de un evento posterior de la misma sesión (`PreToolUse`, `PostToolUse`, `Stop`, `PermissionDenied`, `SessionEnd`) libera con `send(null)`; eventos de otra sesión no tocan la entrada; `onClose` del reply quita la entrada sin enviar; `releaseAll` envía `null` a todas; `onChange` se llama en cada cambio; decidir dos veces el mismo id solo envía una vez.
- [ ] RED → implementar → GREEN.

### Task 4: ClaudeBridge y su configuración

**Files:** Create `src/main/claude/bridge-config.ts`, `src/main/claude/claude-bridge.ts`, tests `tests/unit/main/claude-bridge-config.test.ts`, `tests/unit/main/claude-bridge.test.ts`.

**Interfaces — Produces:** `loadBridgeConfig({ file, encrypt, decrypt, randomToken }) → Promise<{ port: number; token: string }>` (crea el archivo si falta; si no se puede descifrar, genera un token nuevo); `rotateToken(...)`. `createClaudeBridge({ port, token, onEvent(e: HookEvent, reply: PendingReply | null): void, logger })` → `{ start(): Promise<void>; stop(): Promise<void>; port(): number }`; `reply` solo para `PermissionRequest` (el resto se responde 200 vacío antes de llamar a `onEvent`).

- [ ] Tests (servidor real en puerto 0): sin token o token erróneo → 403; otra ruta → 404, otro método → 405; cuerpo > 256 KiB → 413 sin parsear; JSON inválido o evento desconocido → 400; evento válido → 200 vacío y `onEvent`; `PermissionRequest` → respuesta retenida hasta `reply.send`; el logger nunca contiene valores de `prompt`/`tool_input`; `stop()` cierra conexiones abiertas. Config: el archivo guarda el token cifrado (nunca en claro), mismo token entre cargas, `rotateToken` lo cambia.
- [ ] RED → implementar (`node:http`, `timingSafeEqual`) → GREEN.

### Task 5: HookInstaller

**Files:** Create `src/main/claude/hook-installer.ts`, test `tests/unit/main/claude-hook-installer.test.ts`.

**Interfaces — Produces:** `planInstall(current: string | null, { port, token }) → { ok: true; next: string; diff: DiffLine[] } | { ok: false; reason: 'invalid-json' }`; `planUninstall(current: string)` → mismo tipo; `hookStatus(current, { port, token }) → 'installed' | 'outdated' | 'missing'`; adaptador `createHookInstaller({ file, readFile, writeFileAtomic, backupDir, now })` → `{ preview(); install(); uninstall(); status() }`.

- [ ] Tests: añade un grupo marcado por cada evento de Global Constraints sin tocar grupos ajenos (fixture con hooks tipo Coucou); idempotente; reinstalar con token nuevo sustituye solo los grupos propios; desinstalar justo después de instalar devuelve **exactamente** el texto original; si hubo otros cambios entretanto, quita solo los grupos marcados; archivo ausente → crea `{ "hooks": … }`; JSON inválido o BOM → `invalid-json` y no escribe; `install` guarda backup `settings.backup-<fecha>.json` antes de escribir; `diff` lista líneas añadidas y quitadas.
- [ ] RED → implementar (para "exactamente el original": guardar el texto previo junto al backup y restaurarlo si el JSON actual sin grupos propios equivale al original) → GREEN.

### Task 6: Traer Claude al frente y toast

**Files:** Create `src/main/claude/bring-claude-to-front.ts` (koffi, API inyectable), `src/main/claude/toast.ts`; tests `tests/unit/main/claude-bring-to-front.test.ts`, `tests/unit/main/claude-toast.test.ts`.

**Interfaces — Produces:** `bringClaudeToFront(win32: Win32FocusApi) → 'focused' | 'not-running' | 'blocked'` con la secuencia validada (`AttachThreadInput` → restaurar si minimizada → `BringWindowToTop` → `SetForegroundWindow` → desadjuntar); `createPermissionToast({ notify, translate })` → `{ show(p: PendingPermission, onClick: () => void): void }` (texto "Claude espera permiso · <sesión>", sin comando y sin botones).

- [ ] Tests con API Win32 falsa: sin ventana `claude.exe` → `not-running`; siempre desadjunta, aunque falle; restaura si está minimizada. Toast: texto sin el comando; click → callback.
- [ ] RED → implementar → GREEN.

### Task 7: ClaudeService, IPC y cableado en main

**Files:** Create `src/main/claude/claude-service.ts`; Modify `src/shared/ipc/channels.ts`, `src/shared/ipc/contract.ts`, `src/main/index.ts`; tests `tests/unit/main/claude-service.test.ts`, `register-ipc.test.ts`, `ipc-contract.test.ts`.

**Interfaces — Produces:** `ClaudeState = { connection: 'connected' | 'waiting-for-events' | 'not-installed' | 'error'; sessions: ClaudeSession[]; pending: PendingPermission[] }`; los canales de la spec (`claude:get-state`, `claude:decide` `{ requestId: uuid, decision }`, `claude:focus-app`, `claude:dismiss-session`, `claude:hooks-preview|install|uninstall`, `claude:test-connection`, `claude:rotate-token`) y el evento `claude:state-changed`.

- [ ] Tests: el servicio combina registry + broker + estado del instalador; `decide` con id inexistente → `NOT_FOUND` (añadir el código a `IpcErrorCode`); guards: `claude:decide`/`claude:focus-app`/`claude:dismiss-session` solo notch, hooks/test/token solo Control Center (tabla por canal); ningún payload IPC contiene el token; `claude:test-connection` hace un POST real al bridge.
- [ ] Cableado: arrancar el bridge tras `settings.load()`; `tick()` cada 60 s; el notch recibe `{ type: 'attention', on: pending.length > 0 }`; toast si la cápsula está oculta o el panel cerrado; al salir, `broker.releaseAll()` y `bridge.stop()`; puerto ocupado → `connection: 'error'` y el resto de la app sigue.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 8: Estado del notch — modo alerta y vista de permiso

**Files:** Modify `src/shared/notch/state.ts`, `geometry.ts`, `src/main/windows/notch-controller.ts`, `src/shared/ipc/contract.ts` (`notchModeSchema`); tests de estado, geometría y controlador.

**Interfaces — Produces:** `NotchState.attention: boolean`; evento `{ type: 'attention'; on: boolean }`; modo `alert` (no expandido, con atención, no oculto) con `CAPSULE_SIZES.alert = { width: 320, height: 44 }`; vista `permission` y modo `permission` con `CAPSULE_SIZES.permission = { width: 480, height: 300 }`; al expandir con atención, la vista inicial es `permission`; sin pendientes vuelve a `home`. `PANEL_MODES` incluye `permission`.

- [ ] Tests: atención en compact → alert; expand en alert → permission; dismiss → alert mientras siga la atención; atención off con la vista permission abierta → expanded (home); hidden (pantalla completa) gana a alert; mini + atención → alert; el controlador enfoca al entrar en `permission` y devuelve el foco al salir.
- [ ] RED → implementar → GREEN.

### Task 9: Renderer — cápsula, alerta, tarjeta de permiso, sección de sesiones

**Files:** Create `src/renderer/notch/claude/StatusDots.tsx`, `AlertCapsule.tsx`, `PermissionCard.tsx`, `SessionsSection.tsx`, `src/renderer/shared/claude-store.ts`; Modify `NotchApp.tsx`, `messages.ts`; tests `tests/unit/shared/i18n.test.ts`.

- [ ] Store: suscribe `claude:state-changed` y lee `claude:get-state` al arrancar (mismo patrón que `useNotchMode`).
- [ ] Compact: hasta 4 puntos (8 px, halo de 3 px al 22 %) + `+N`; `done` visible 8 s y luego se apaga.
- [ ] Alerta: punto Ámbar Espera con pulso de 1,6 s (solo opacidad con `prefers-reduced-motion`), nombre de sesión y herramienta, truncado con elipsis.
- [ ] Tarjeta: sesión, herramienta, `preview` en Geist Mono 12.5 px con scroll vertical (texto plano), botones **Denegar** (secundario) y **Permitir** (Azul Hielo) que solo reaccionan a `click`: `onKeyDown` anula Enter y Espacio; "1 de N".
- [ ] Sección "Claude Code" en el panel `home` (solo si hay sesiones): nombre, estado con icono + texto, tiempo relativo, × en idle; click en la fila → `claude:focus-app`.
- [ ] i18n ES/EN para etiquetas y estados.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 10: Control Center — página "Claude Code"

**Files:** Create `src/renderer/control-center/ClaudePage.tsx`; Modify `ControlCenterApp.tsx`, `messages.ts`.

- [ ] Estado de conexión con texto; "Instalar hooks" muestra el diff (añadidas en Verde Listo, quitadas en Rojo Fallo, Geist Mono) y pide confirmar; "Desinstalar"; "Probar conexión"; "Rotar token" (reinstala si estaban instalados); errores visibles (`invalid-json` → "Tu settings.json no es JSON válido; no se ha tocado").
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 11: E2E y capturas

**Files:** Create `tests/e2e/claude.spec.ts`; Modify `src/main/index.ts` para aceptar `NOTCH_CLAUDE_SETTINGS` (ruta de un `settings.json` temporal), solo en desarrollo, como las otras variables `NOTCH_*`.

- [ ] El test instala los hooks desde el Control Center en el `settings.json` temporal y lee de ahí la URL y el token, igual que haría Claude; después envía los eventos por HTTP.
- [ ] Casos: secuencia working→done (puntos); `PermissionRequest` → modo `alert` en < 1 s → expandir → click en Permitir → la petición HTTP pendiente recibe el JSON `allow`; segundo caso con Denegar; un `PostToolUse` posterior retira la alerta y la petición recibe 200 vacío; Enter/Espacio sobre los botones no decide; Control Center: instalar muestra el diff y conserva un hook ajeno, desinstalar deja el archivo idéntico; capturas `test-results/m3-*.png` (compact con puntos, alert, permission, panel con sesiones, Control Center).
- [ ] `npm run test:e2e` → PASS (incluidos M1 y M2).

### Task 12: Verificación

- [ ] Revisión de seguridad con subagente (bridge, broker, guards, instalador, logs) y revisión de la rama completa.
- [ ] Latencia evento → cápsula medida en E2E (< 1 s).
- [ ] Prueba manual con la app Claude real: instalar desde el Control Center, sesión en modo default, aprobar desde el notch, responder en la app, desinstalar y comprobar que `settings.json` queda idéntico.
- [ ] Actualizar PRD (permisos desde el notch: de "could" a hecho) y los hallazgos.
