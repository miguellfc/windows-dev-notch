# M3 · Prueba de hooks desde la app de escritorio — Hallazgos

**Fecha:** 2026-11-09/10 · **Código:** desechable, fuera del repo (scratchpad de la sesión).
**Montaje:** bridge HTTP en `127.0.0.1` con token; se añadieron grupos de hooks `http` propios (timeout 2 s) a `~/.claude/settings.json` sin tocar los de Coucou, y al final se restauró el archivo **idéntico byte a byte**. Solo se registraron nombres de eventos y de campos, `notification_type`, `tool_name` y `permission_mode`; nunca prompts, mensajes ni comandos.

## Veredicto

La duda abierta en M0 queda resuelta: **la app de escritorio dispara `PermissionRequest` y `Notification` (`permission_prompt`)** cuando una sesión pide permiso, y los recoge en caliente (sin reiniciar Claude). El diseño de M3 (hooks `http` → bridge local) se confirma.

## Secuencias observadas (app de escritorio, pestaña Code)

**Sesión en modo `default` (pide permiso)**

| t | Evento | Notas |
|---|---|---|
| 0 s | `UserPromptSubmit` | `permission_mode: default` |
| +5–10 s | `PreToolUse` ×3 (`Bash`) | |
| +10 s | `PermissionRequest` (`Bash`) | **al instante**, con `tool_input` y `permission_suggestions` |
| +16 s | `Notification` · `permission_prompt` | **~6 s después** que `PermissionRequest`; trae `message` |
| +29 s | `PostToolUse` | el usuario aprobó |
| +35 s | `Stop` | |

**Sesiones en modo `auto`:** `UserPromptSubmit` → `PreToolUse`… → `PostToolUse` → `Stop`; nunca `PermissionRequest` ni `Notification`. Hubo más `PreToolUse` que `PostToolUse` (llamadas descartadas por el modo auto).
**Al cerrar una sesión:** `Stop` → `SubagentStop` (2 s después) → `SessionEnd` con `reason`.

## Lo que no llegó

- **`SessionStart`**: en ninguna de las tres sesiones nuevas. El primer evento fue siempre `UserPromptSubmit`.
- **`Notification` · `idle_prompt`**: ni a los ~3 min de un `Stop` (la documentación habla de ~60 s). No se puede usar para "Claude espera tu respuesta"; la inactividad la calcula el notch.

## Campos por evento (nombres)

| Evento | Campos |
|---|---|
| todos | `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `hook_event_name` |
| `UserPromptSubmit` | + `permission_mode`, `prompt` |
| `PreToolUse` | + `permission_mode`, `effort`, `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | + `permission_mode`, `effort`, `tool_name`, `tool_input`, `permission_suggestions` |
| `Notification` | + `message`, `notification_type` |
| `PostToolUse` | + `permission_mode`, `effort`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` |
| `Stop` | + `permission_mode`, `effort`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` |
| `SubagentStop` | + `agent_id`, `agent_type`, `agent_transcript_path`, … |
| `SessionEnd` | + `reason` |

## Prueba 2 · `PermissionRequest` retenido (2026-11-10)

Mismo montaje, pero el bridge **no responde** a `PermissionRequest` (hook con `timeout: 3600`) hasta decidirlo a mano.

| Ronda | Qué pasó |
|---|---|
| A · se responde en la app | La app **muestra su diálogo aunque el hook siga retenido** (el usuario lo vio a los >15 s). Al aprobar en la app llega `PostToolUse`, pero **Claude no cierra la conexión del hook**: siguió abierta 85 s hasta liberarla sin decisión (200 vacío), sin efectos. |
| B · decide el bridge a los 8 s (`allow`) | `PostToolUse` 0,2 s después; **el diálogo de la app no llegó a aparecer**. |

- `timeout: 3600` se aceptó (el hook siguió retenido 85 s sin error); no se esperó más de 10 min para comprobar si Claude lo recorta a 600 s. Si lo recortara, Claude seguiría sin decisión y la petición quedaría en la app: no bloquea.
- Convive con el hook `PermissionRequest` de Coucou: ninguno anuló al otro.

**Traer la app Claude al frente** desde un proceso en segundo plano: `SetForegroundWindow` a secas → bloqueado (`false`); con `AttachThreadInput` al hilo de la ventana en primer plano + `BringWindowToTop` + `SetForegroundWindow` → **funciona**, sin simular Alt.

## Implicaciones para M3

1. "Esperando permiso" se basa en **`PermissionRequest`** (instantáneo); `Notification: permission_prompt` sirve de respaldo.
2. Salir de "esperando": el siguiente `PostToolUse`/`PreToolUse`/`Stop` de esa sesión.
3. Una sesión aparece con su primer evento (normalmente `UserPromptSubmit`), no con `SessionStart`; desaparece con `SessionEnd`.
4. `Stop` no es el final absoluto (puede seguir un `SubagentStop`); "terminada" = `Stop` sin actividad posterior.
5. Inactividad (30 min) calculada por el notch; no esperar `idle_prompt`.
6. Esquemas zod tolerantes: campos opcionales y desconocidos permitidos.
7. Datos sensibles en `prompt`, `tool_input`, `tool_response`, `last_assistant_message`, `message`: no se registran; como mucho, un extracto en la UI.
8. Respuesta del bridge: **200 sin cuerpo** = éxito sin decisión (documentado). Con `onFailure: continue` (por defecto), si el notch está cerrado Claude sigue sin bloquearse.
9. Al resolverse en la app, la conexión del hook **no se cierra sola**: el broker la cierra (200 vacío) al ver el siguiente evento de la sesión.
10. Decidir en el notch antes de que aparezca el diálogo de la app evita el diálogo; después, ambos conviven.
11. Traer Claude al frente con `AttachThreadInput`; no hace falta el truco de Alt.
