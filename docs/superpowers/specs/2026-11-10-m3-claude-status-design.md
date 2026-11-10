# M3 · Estado de Claude Code y permisos desde el notch — Diseño

**Fecha:** 2026-11-10 · **Rama:** `feat/m3-claude-status` (desde `fix/terminal-exit`)
**Fuentes:** PRD (M3, criterios 15–20), `PRODUCT.md`, `DESIGN.md`, `docs/spikes/m0-findings.md`, `docs/spikes/m3-hooks-findings.md`. Sustituye las tareas 3.1–3.6 del plan del MVP.

## Objetivo

Ver de un vistazo qué hace cada sesión de Claude Code y **aprobar o denegar sus permisos desde el notch**, sin ir a la app Claude.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Alcance de permisos | **Avisar y aprobar/denegar** desde el notch (antes "could" post-MVP) |
| Opciones | **Permitir una vez / Denegar**. Nunca "permitir siempre": no se guardan reglas desde el notch |
| Confirmación | **Solo click** en los botones. Ningún atajo de teclado aprueba ni deniega |
| Sin decisión | El notch **espera sin límite**; si se responde en la app Claude, la alerta del notch desaparece |
| Cápsula en reposo | Un punto de estado por sesión; la alerta de permiso ensancha la cápsula; cola si hay varias |
| Panel expandido | Sección fija "Claude Code" arriba (si hay sesiones) y debajo la fila de integraciones |
| Ir a la sesión | Traer la app Claude al frente; probar `AttachThreadInput` antes que el truco de Alt de M0 |

## Hechos de la prueba que fijan el diseño

- `PermissionRequest` llega al instante; `Notification: permission_prompt` ~6 s después (respaldo).
- No llega `SessionStart` ni `idle_prompt`: la sesión aparece con su primer evento y la inactividad la calcula el notch.
- `Stop` puede ir seguido de `SubagentStop`; `SessionEnd` trae `reason`.
- 200 sin cuerpo = éxito sin decisión; con `onFailure: continue` (por defecto) un notch cerrado no bloquea a Claude.

## Prueba previa — resultado (2026-11-10)

Hecha: ver "Prueba 2" en `docs/spikes/m3-hooks-findings.md`. (1) Sí: la app muestra su diálogo aunque el hook esté retenido; (2) al responder en la app llega `PostToolUse` y la conexión **sigue abierta** (el broker debe cerrarla); (3) `timeout: 3600` aceptado, sin comprobar si se recorta a 600 s, y un recorte no bloquea; (4) `AttachThreadInput` funciona; (5) convive con Coucou. La decisión "espera sin límite" se mantiene. El hook se instala con `timeout: 3600`.

## Prueba previa (planteamiento original)

Spike desechable con el hook `PermissionRequest` retenido:
1. ¿La app Claude muestra su diálogo de permiso mientras el hook espera?
2. Si se responde en la app, ¿Claude cierra la conexión del hook? ¿Llega `PermissionDenied`/`PostToolUse`?
3. ¿Qué `timeout` máximo admite el hook (valor por defecto documentado: 600 s)?
4. ¿Funciona `AttachThreadInput` + `SetForegroundWindow` para traer la app Claude sin simular Alt?
5. ¿Convive con el hook `PermissionRequest` de Coucou (que también está instalado) sin que una decisión anule a la otra?

Si (1) es "no" y el timeout tiene un máximo bajo, se vuelve al usuario antes de implementar el broker (la decisión "sin límite" depende de ello).

## Arquitectura

### Main (`src/main/claude/`)

- **`claude-bridge.ts`**: `http.createServer` en `127.0.0.1:<puerto>` (puerto aleatorio 49152–65535 elegido al crear `claude-bridge.json` y persistido, para que otra cuenta local no pueda adivinarlo; "Cambiar de puerto" en el Control Center; rechaza cualquier `Host` distinto de `127.0.0.1:<puerto>`/`localhost:<puerto>`). Exige `x-notch-token` (token aleatorio de 32 bytes guardado con `safeStorage`). Solo `POST /hook`, `content-type` JSON, cuerpo ≤ 256 KiB. Valida con zod tolerante (`looseObject`, campos opcionales). Responde 200 sin cuerpo salvo `PermissionRequest`. Nunca registra `prompt`, `tool_input`, `tool_response`, `message` ni `last_assistant_message`.
- **`session-registry.ts`** (puro): estados `working | waiting | done | error | idle`.
  - `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart/Stop` → `working` (salvo que haya permiso pendiente).
  - `PermissionRequest` o `Notification: permission_prompt` → `waiting`.
  - `Stop` → `done`; `StopFailure` → `error`; `SessionEnd` → eliminar.
  - 30 min sin eventos → `idle`; `idle` se puede descartar.
  - Datos guardados: `sessionId`, nombre (último segmento de `cwd`), estado, `updatedAt`. Nada de textos de usuario.
- **`permission-broker.ts`**: por cada `PermissionRequest`, una entrada `{ id, sessionId, toolName, preview, receivedAt }` y la respuesta HTTP **retenida**.
  - `decide(id, 'allow' | 'deny')` → responde `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny"}}}` y retira la entrada.
  - *Actualizado tras la revisión final:* cada petición se liga al `tool_use_id` de su `PreToolUse` (misma sesión, agente y herramienta) y solo la retira el final de **esa** llamada (`PostToolUse`, `PostToolUseFailure`, `PermissionDenied`) o el fin de la sesión o del turno (`Stop`, `StopFailure`, `UserPromptSubmit`, `SessionEnd`); un `PreToolUse` ya no retira nada. La vista previa muestra el comando (o el `tool_input` completo en JSON para otras herramientas), sin caracteres de formato invisibles; si supera 2 000 caracteres se marca como recortada y **Permitir se desactiva**.
  - (Planteamiento original) Se retira **sin decisión** (200 vacío si la conexión sigue abierta) cuando: llega otro evento de esa sesión que implique que la petición se resolvió en la app (cualquier `PreToolUse` o `PostToolUse` posterior a la petición, `Stop`, `PermissionDenied`, `SessionEnd`; la prueba previa confirma cuáles llegan de verdad), o Claude cierra la conexión.
  - `preview`: herramienta + comando/ruta acotado (p. ej. 2 000 caracteres), solo en memoria.
- **`hook-installer.ts`**: lee `~/.claude/settings.json`; añade grupos propios marcados (`headers: { "x-notch-hook": "1" }`) para `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest` (timeout alto según la prueba), `PermissionDenied`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`; nunca toca otros grupos. Diff antes de escribir, backup con fecha, escritura atómica; desinstalar quita solo los grupos marcados y deja el archivo como estaba; idempotente; tolera archivo ausente; se niega (sin escribir) ante JSON corrupto.
- **`bring-claude-to-front.ts`** (koffi): localiza la ventana visible con título de `claude.exe` (como en M0), restaura si está minimizada y la trae al frente con `AttachThreadInput` (hilo de la ventana en primer plano) + `BringWindowToTop` + `SetForegroundWindow` (validado en la prueba); sin truco de Alt.
- **Toast**: `Notification` de Electron solo informativo ("Claude espera permiso · <sesión>"); click → expande el notch en la alerta. Sin botones de decisión.

### IPC

| Canal | Entrada | Salida | Quién |
|---|---|---|---|
| `claude:get-state` | — | `{ connection, sessions[], pending[] }` | notch, Control Center |
| `claude:decide` | `{ requestId: uuid, decision: 'allow' \| 'deny' }` | `null` | **solo el notch** (guard por `webContents`, como la terminal) |
| `claude:focus-app` | — | `null` | notch |
| `claude:dismiss-session` | `{ sessionId }` (solo `idle`) | `null` | notch |
| `claude:hooks-preview` / `claude:hooks-install` / `claude:hooks-uninstall` | — | diff / estado | **solo el Control Center** |
| `claude:test-connection` / `claude:rotate-token` | — | resultado | solo el Control Center |

Evento main → renderers: `claude:state-changed`. Los `requestId` los genera main (uuid); el renderer solo puede decidir sobre peticiones pendientes existentes.

### Renderer

- **Cápsula** (`compact`): hasta 4 puntos de estado (Azul Hielo trabajando, Verde Listo terminada durante unos segundos, Rojo Fallo error) y `+N`; sin sesiones, igual que ahora.
- **Modo `alert`** (~44 px de alto, ya previsto en DESIGN.md): punto Ámbar Espera pulsando (1,6 s), nombre de la sesión y herramienta. Click o atajo → panel con la **tarjeta de permiso**: sesión, herramienta, comando completo en Geist Mono con scroll, botones **Denegar** y **Permitir** (solo click), y "1 de N" si hay cola (la más antigua primero).
- **Panel**: sección "Claude Code" (lista: nombre, estado con texto + icono, tiempo relativo, × para descartar inactivas; click → traer la app Claude) encima de la fila de integraciones.
- **Control Center → "Claude Code"**: estado de conexión, instalar/desinstalar con diff visible, probar conexión, rotar token (reinstala los hooks con el nuevo token).
- Estado "no conectado" cuando no hay hooks instalados o no llegan eventos; el resto del notch funciona igual.
- i18n ES/EN para todo.

## Seguridad

1. El bridge solo escucha en `127.0.0.1`, con token, tamaño acotado y validación zod; peticiones inválidas → 4xx sin efectos.
2. Solo el webContents del notch puede llamar a `claude:decide`; solo el Control Center instala o desinstala hooks.
3. Una decisión solo existe tras un **click** del usuario en un botón; ningún atajo global ni de teclado aprueba.
4. Solo "permitir una vez" o "denegar"; nunca se escriben reglas de permiso.
5. Nada sensible en logs ni en disco; la vista previa del comando vive en memoria.
6. El instalador nunca modifica hooks ajenos (p. ej. Coucou) y deja `settings.json` idéntico al desinstalar.
7. Si el notch no está en marcha, Claude sigue funcionando (`onFailure: continue`).

## Pruebas

- **Unitarias (TDD):** `session-registry` con secuencias reales de la prueba y reloj falso; `permission-broker` (decidir, retirar por evento, retirar por cierre de conexión, cola ordenada); `claude-bridge` (sin token, tamaño, JSON inválido, 200 vacío, respuesta de decisión); `hook-installer` (conserva hooks ajenos, idempotente, desinstalación exacta, ausente, corrupto); contratos IPC y guards.
- **E2E:** POST de eventos al bridge → cápsula en cada estado; alerta → click en Permitir → la petición HTTP recibe `allow`; respuesta en "la app" (evento posterior) → la alerta desaparece; Control Center instala sobre un `settings.json` temporal y desinstala dejándolo idéntico; capturas de todos los estados.
- **Después:** revisión de seguridad con subagente; latencia evento → cápsula < 1 s; prueba manual con la app Claude real.

## Fuera de alcance

"Permitir siempre"; abrir una sesión concreta de la app Claude; proveedores de agentes distintos de Claude Code; leer transcripts.
