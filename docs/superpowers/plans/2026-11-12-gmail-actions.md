# Gmail en el notch — Hitos 2 y 3: leer, actuar y avisos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leer correos de Principal en texto plano dentro del notch, marcarlos como leídos o borrarlos para siempre con confirmación, y avisar de correo nuevo en la cápsula.

**Architecture:** main gana un extractor puro MIME → texto (`html-to-text`), un detector puro de correo nuevo por ids no leídos y tres operaciones del cliente REST; la integración controla qué ids puede tocar el notch, emite `gmail:new-mail` y dispara un aviso de tipo correo en el estado del notch (modo `alert`, prioridad más baja). El renderer solo recibe texto.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Zustand, zod 4, `html-to-text`, Lucide, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-12-gmail-actions-design.md` (se apoya en `2026-11-11-gmail-design.md`).

## Global Constraints

- Permiso: `GMAIL_SCOPE = 'https://mail.google.com/'`. Un `scope` devuelto por Google sin ese valor → `expired` con `reason: 'scope'`.
- Borrar = `DELETE users/me/messages/{id}` (definitivo), siempre tras confirmación en la UI; marcar leído = `POST messages/{id}/modify` `{ removeLabelIds: ['UNREAD'] }`; 404 en ambos cuenta como hecho.
- Lectura: `messages/{id}?format=full`; texto plano; cuerpo ≤ **50 000** caracteres (`truncated`); enlaces solo `http`/`https`, sin duplicados, ≤ **50**; adjuntos = partes con `filename` no vacío; charsets UTF-8, ISO-8859-1, Windows-1252 (otros → UTF-8 con sustitución).
- `message`, `mark-read`, `delete`, `open-link` solo aceptan ids **mostrados** al notch (última lista + correo abierto + último aviso). `open-link { id, index }` abre `links[index]` del correo abierto; el renderer nunca envía URLs.
- Correo nuevo: ids no leídos presentes ahora y ausentes en la consulta anterior; la primera consulta tras `reset()` no avisa; `reset()` al iniciar/cerrar sesión, cambiar cliente y reanudar tras una pausa ≥ **60 s**.
- Aviso: tipo correo en modo `alert`, **prioridad más baja** (permiso de Claude y recordatorios antes), **6 000 ms**, no se muestra con un panel abierto, no roba el foco. Texto: "**{from}** · {subject}", "Correo nuevo" (oculto o sin datos), "N correos nuevos" (`count > 1`).
- Ajustes v5: `gmail.alerts = { enabled: true, hideContent: false, sound: true }`; con `hideContent` el evento no lleva `from`/`subject`. Sonido = `playChime()` existente (`src/renderer/notch/reminders/chime.ts`).
- Vista de lectura ~**520×440** (medida con capturas); lista y aviso con objetivos ≥ 24 px; i18n ES/EN; tokens de `DESIGN.md`; texto de correo siempre como texto.
- Log y disco: nunca cuerpos, enlaces, asuntos, remitentes, tokens ni secreto. El cuerpo solo en memoria mientras se lee.
- Sin commits por tarea. No modificar `eslint.config.mjs`. Nunca manejar el escritorio ni el navegador del usuario.

## Review Focus

1. **Borrar un correo que ya no existe o que cambió de lista mientras se confirmaba** → 404 cuenta como hecho, la lista se refresca y no se borra otro id (Task 4, Task 5, Task 7).
2. **Correo HTML hostil** (`<script>`, `<style>`, `javascript:` y `data:` en `href`, entidades, cuerpos enormes) → solo texto, enlaces solo `http`/`https`, recorte a 50 000 (Task 2).
3. **Aviso mientras hay un permiso de Claude o un recordatorio** → el de correo espera o se descarta, nunca los tapa (Task 6).
4. **Sesión del hito 1 con `gmail.readonly`** → `expired` con `reason: 'scope'` en el arranque, sin peticiones que fallen en bucle (Task 5).
5. **Ráfaga de correos o vuelta de una pausa larga** → un solo aviso "N correos nuevos" o ninguno tras la pausa (Task 3, Task 5).

---

### Task 1: Esquemas, permiso y ajustes v5

**Files:** Modify `src/shared/gmail/schema.ts`, `src/main/gmail/gmail-auth.ts` (`GMAIL_SCOPE`), `src/shared/settings/schema.ts`, `src/main/services/settings-migrations.ts`; tests `tests/unit/shared/gmail-schema.test.ts`, `settings-schema.test.ts`, `tests/unit/main/settings-migrations.test.ts`, `gmail-auth.test.ts`.

**Interfaces — Produces:** `GMAIL_BODY_MAX = 50_000`, `GMAIL_LINKS_MAX = 50`; `gmailMessageDetailSchema` / `GmailMessageDetail` (spec, "Modelo"); `gmailNewMailSchema` / `GmailNewMail`; `gmailStateSchema` con `reason: 'scope' | null`; `gmailIdInputSchema { id }` (1–64), `gmailOpenLinkInputSchema { id, index: int 0–49 }`; `messageFullSchema` (respuesta `format=full`: `payload` con `mimeType`, `filename?`, `headers`, `body: { data?, size }`, `parts?` recursivo; no estricto); `gmailAlertSettingsSchema`, `DEFAULT_GMAIL_ALERTS`, `SETTINGS_VERSION = 5`, migración 4 → 5; `GMAIL_SCOPE = 'https://mail.google.com/'`; `hasRequiredScope(scope: string | undefined): boolean`.

- [ ] Tests: detalle estricto con los límites; `index` 0–49; v4 migra a v5 con `DEFAULT_GMAIL_ALERTS` sin tocar `clientId`/`clientSecret`; `hasRequiredScope('https://mail.google.com/ openid')` true, `'…/gmail.readonly'` false, `undefined` false; la URL de autorización pide el permiso nuevo; tests con versión fija actualizados.
- [ ] RED → GREEN.

### Task 2: Texto del correo

**Files:** Create `src/main/gmail/message-text.ts`; add dependency `html-to-text` (+ `@types/html-to-text` si hace falta) en `package.json`; test `tests/unit/main/gmail-message-text.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** `extractMessage(payload: MessagePayload): { body: string; truncated: boolean; links: { text: string; url: string }[]; attachments: number }`.

- [ ] Tests: solo `text/plain`; solo `text/html` (`<p>`, `<br>`, `<ul>` → saltos); `multipart/alternative` prefiere texto; `multipart/mixed` anidado con adjunto (cuenta 1); base64url con `-`/`_` y sin relleno; `charset=iso-8859-1` y `windows-1252` (ñ, €); `<script>`/`<style>` desaparecen; `href="javascript:…"` y `data:` descartados; enlaces duplicados una vez; 60 enlaces → 50; cuerpo de 60 000 → 50 000 y `truncated`; sin cuerpo → `''`.
- [ ] RED → GREEN.

### Task 3: Detector de correo nuevo

**Files:** Create `src/main/gmail/new-mail.ts`; test `tests/unit/main/gmail-new-mail.test.ts`.

**Interfaces — Produces:** `createNewMailDetector()` → `{ observe(unreadIds: readonly string[]): string[]; reset(): void }` (spec, "new-mail.ts").

- [ ] Tests: primera observación → `[]`; id nuevo → `[id]`; varios nuevos en orden de la lista; ids que desaparecen no cuentan; un id que vuelve tras desaparecer cuenta como nuevo; `reset()` → la siguiente observación vuelve a ser referencia.
- [ ] RED → GREEN.

### Task 4: Cliente: leer, marcar y borrar

**Files:** Modify `src/main/gmail/gmail-client.ts`; test `tests/unit/main/gmail-client.test.ts`.

**Interfaces — Consumes:** Tasks 1–2. **Produces:** `unreadIds(): Promise<string[]>` (la consulta del contador; `unreadCount` pasa a derivarse de ella o se sustituye — elegir uno y actualizar la integración en Task 5); `message(id): Promise<GmailMessageDetail>`; `markRead(id): Promise<void>`; `remove(id): Promise<void>`; `GmailApiError` gana `'not-found'`.

- [ ] Tests: `message` pide `format=full` y compone el detalle (remitente nombre y dirección con `displaySender` y una nueva `senderAddress`, asunto, fecha, `unread`, cuerpo de `extractMessage`); `message` 404 → `not-found`; `markRead` envía `POST …/modify` con `{ removeLabelIds: ['UNREAD'] }`; `remove` envía `DELETE`; 404 en `markRead`/`remove` → resuelve; 401 → refresco como el resto.
- [ ] RED → GREEN.

### Task 5: Integración, IPC y cableado

**Files:** Modify `src/main/gmail/gmail-integration.ts`, `gmail-ipc.ts`, `src/shared/ipc/channels.ts`, `contract.ts`, `api.ts`, `src/main/index.ts`; tests `tests/unit/main/gmail-integration.test.ts`, `gmail-ipc.test.ts`, `register-ipc.test.ts`, `tests/unit/shared/ipc-contract.test.ts`.

**Interfaces — Consumes:** Tasks 1–4. **Produces:** en la integración `message(id)`, `markRead(id)`, `remove(id)`, `openLink(id, index)`, opción `onNewMail(mail: GmailNewMail)`; canales `gmail:message|mark-read|delete|open-link` (solo notch) y evento `gmail:new-mail` (main → notch).

- [ ] Tests (temporizadores falsos):
  - ids mostrados: un id de la lista se acepta; uno ajeno → `INVALID_INPUT` sin petición; el abierto y el del último aviso también cuentan;
  - `openLink` con índice fuera de rango o de otro correo → rechazado; válido → `openExternal(url)`;
  - tras `markRead`/`remove` correctos → consulta inmediata;
  - correo nuevo con avisos activos → pide metadatos del más reciente y llama `onNewMail` con `count`, `id`, `from`, `subject`; con `hideContent` sin `from`/`subject`; con avisos desactivados no llama; primera consulta y tras pausa ≥ 60 s no llama (Review Focus 5);
  - `scope` sin `https://mail.google.com/` al refrescar → `expired` + `reason: 'scope'` y sin más peticiones (Review Focus 4);
  - el correo abierto se olvida al cerrar la lectura (`gmail:view {open:false}` o un nuevo `message`) y al cerrar sesión;
  - el log no contiene cuerpos, enlaces, asuntos ni remitentes.
- [ ] IPC: guards solo notch, zod de entrada/salida, errores `INVALID_INPUT`/`NOT_FOUND` expuestos.
- [ ] Cableado: `onNewMail` → `emitEvent('gmail:new-mail')` al notch y aviso de correo en el controlador del notch (Task 6).
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 6: Aviso de correo en el estado del notch

**Files:** Modify `src/shared/notch/state.ts`, el controlador del notch en main (`src/main/notch/…controller`), `src/renderer/notch/NotchApp.tsx`; Create `src/renderer/notch/gmail/MailAlert.tsx`; Modify `messages.ts`; tests `tests/unit/shared/notch-state.test.ts`, `tests/unit/main/notch-controller.test.ts`.

**Interfaces — Produces:** `NotchState.mailAlert: boolean`; evento `{ type: 'mail'; on: boolean }`; `notchMode` → `alert` con `attention || reminderDue || mailAlert`; `openingView` → `permission` > `reminders` > `gmail` (si `mailAlert`) > `home`; el controlador apaga `mailAlert` a los 6 000 ms y lo ignora si el modo es de panel.

- [ ] Tests: `mail on` en `compact` → `alert`; con `attention` o `reminderDue` el modo y la vista que se abre son los suyos (Review Focus 3); con un panel abierto → ignorado; 6 s → `compact`; expandir con `mailAlert` abre `gmail`.
- [ ] `MailAlert`: icono `Mail` + texto de Global Constraints recortado a una línea, `aria-live="polite"`; elegido en NotchApp cuando el modo es `alert` y solo `mailAlert` está activo; clic → abre la vista Gmail y, con `count === 1`, la lectura de `id`; sonido con `playChime()` si `alerts.sound` y la cápsula no está oculta.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 7: Lista con acciones y vista de lectura

**Files:** Modify `src/renderer/notch/gmail/{GmailView,MessageList}.tsx`, `src/renderer/shared/gmail-store.ts`, `src/renderer/shared/gmail/format.ts`, `src/shared/notch/geometry.ts` (tamaño de lectura), `messages.ts`; Create `src/renderer/notch/gmail/{MessageReader,DeleteConfirm}.tsx`; tests `tests/unit/renderer/gmail-format.test.ts`, geometría.

- [ ] Lista: clic/Enter abre la lectura; acciones por fila Marcar leído (solo no leídos) y Borrar, visibles con hover/foco, ≥ 24 px; confirmación en línea "¿Borrar para siempre? Cancelar · Borrar", foco en Cancelar, Esc cancela; error en línea con Reintentar.
- [ ] Lectura: cabecera (←, remitente nombre y dirección, asunto, fecha completa), cuerpo `pre-wrap` con scroll, aviso de recorte, lista "Enlaces" (texto + URL, clic → `gmail:open-link`), "N adjuntos", pie Marcar leído / Borrar / Abrir en Gmail; estados cargando, ya no existe (→ lista), error.
- [ ] Teclado: Esc en lectura → lista con el foco en la misma fila; Esc en lista → fila de integraciones.
- [ ] Tamaño del panel en lectura medido con Playwright (contenido largo con scroll, sin recortar la cabecera ni el pie) y fijado en geometría; `growsWindow`/`resizeOrder` coherentes.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 8: Control Center

**Files:** Modify `src/renderer/control-center/GmailPage.tsx`, `messages.ts`.

- [ ] Sección **Avisos**: `Switch` Avisos de correo nuevo, Ocultar remitente y asunto, Sonido (parche de `gmail.alerts` leyendo el estado más reciente del store); los dos últimos deshabilitados con avisos apagados.
- [ ] Aviso de permiso insuficiente cuando `reason === 'scope'` ("Vuelve a iniciar sesión para conceder el nuevo permiso"); pasos de la página actualizados (permiso `https://mail.google.com/`).
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 9: E2E, guía y capturas

**Files:** Modify `tests/e2e/fixtures/fake-gmail.ts`, `tests/e2e/gmail.spec.ts`, `docs/gmail-setup.md`.

- [ ] Servidor falso: `format=full` con cuerpos de prueba (texto, HTML con enlaces, adjunto), `POST …/modify`, `DELETE`, una función para añadir un correo nuevo no leído; exige el permiso nuevo en `scope`; un modo que emite tokens con `gmail.readonly` para probar `reason: 'scope'`.
- [ ] Spec: abrir un correo y ver su texto; abrir un enlace (URL capturada); marcar leído → el contador baja; borrar con confirmación → desaparece y el servidor recibe `DELETE`; cancelar no borra; correo nuevo → aviso con contenido; con `hideContent` → "Correo nuevo"; sesión con permiso viejo → "Vuelve a iniciar sesión…". Capturas `gmail-reader-es.png`, `gmail-reader-en.png`, `gmail-delete-confirm-es.png`, `gmail-alert-es.png`.
- [ ] Guía: añadir `https://mail.google.com/` en "Acceso a datos", volver a iniciar sesión, qué permite ese permiso y qué usa el notch.
- [ ] `npm run build` y `npm run test:e2e` → PASS (todos los specs).

### Task 10: Verificación y documentación

- [ ] Revisión de la rama completa con subagente.
- [ ] DESIGN.md (aviso de correo, lectura, acciones y confirmación) y PRD (Gmail hitos 2 y 3 hechos).
- [ ] Manual (usuario): volver a iniciar sesión con el permiso nuevo; leer, marcar y borrar un correo de prueba real; recibir un aviso.
