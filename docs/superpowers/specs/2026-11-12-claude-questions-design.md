# Preguntas de Claude Code en el notch — Diseño

**Fecha:** 2026-11-12 · **Rama:** `feat/claude-questions` (desde `dev`)
**Fuentes:** `docs/spikes/askuserquestion-findings.md` (prueba de viabilidad), `docs/superpowers/specs/2026-11-10-m3-claude-status-design.md` (estado y permisos de Claude), documentación de hooks de Claude Code (`https://code.claude.com/docs/en/hooks.md`, secciones PreToolUse y AskUserQuestion), `DESIGN.md`.
> **Cambio (2026-11-12, tras la implementación y la revisión final):** esto prevalece sobre el texto de abajo.
> - Panel `QuestionCard` de **520×504** (ventana 582): es el panel más alto; la ventana crece antes de que la tarjeta se anime.
> - Entrada inválida y toda petición a `/hook` reciben un 200 **vacío** (no `{}`); "Soltar" y "Responder en Claude" envían `{}`.
> - El evento `claude:questions` lleva `PendingQuestionView` (`id`, `project`, `questions`, `arrivedAt`; sin `sessionId`; textos saneados solo para mostrar). Main construye `answers` con los textos originales y devuelve el `tool_input` ORIGINAL con sus claves desconocidas.
> - Reloj de llegada compartido (`receivedAt` de permisos y `arrivedAt` de preguntas) y evento `claude-first` del notch: abre primero la más antigua.
> - Intención `next`: la tarjeta muestra "Respuesta enviada" ~1 s o "Esta pregunta ya no está pendiente" ~1,6 s y pasa a la siguiente pendiente o se cierra.
> - Enter sobre una opción nunca envía; "Otro" vacío mantiene "Enviar" deshabilitado; en `multiSelect` las etiquetas van en el orden de las opciones.
> - Accesibilidad: línea `role="status"` siempre montada, `aria-describedby` en "Otro" y `aria-keyshortcuts`.
> - Una pregunta pendiente pone la sesión en `waiting`.
> - Solo desarrollo/pruebas: `NOTCH_DISABLE_CLAUDE_FOCUS` (se ignora con la app empaquetada).
> - Quien ya tenía los hooks instalados debe reinstalarlos una vez desde Control Center (`hookStatus` muestra "Desactualizados: reinstala"); hasta entonces las preguntas caen al diálogo propio de Claude.


## Objetivo

Cuando Claude Code necesita que el usuario elija entre varias opciones (herramienta `AskUserQuestion`), contestar desde el notch sin abrir la ventana de Claude, igual que ya se hace con los permisos (Permitir/Denegar).

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Qué hace el notch | **Responder** la pregunta (no solo avisar) |
| Mecanismo | Hook `PreToolUse` con `matcher: "AskUserQuestion"` que responde `permissionDecision: "allow"` + `updatedInput` (preguntas originales + `answers`). Verificado en la app de escritorio (spike) |
| Interacción | **Clic y teclado** (flechas, Espacio, Tab, Ctrl+Enter); a diferencia de los permisos, no es solo clic |
| Aviso | **Igual que un permiso**: aviso en la cápsula (también en `mini` y oculta) hasta contestar, misma prioridad que un permiso, y toast de Windows |
| "Otro" | Siempre disponible: texto libre (verificado que Claude lo acepta) |

## Comportamiento del hook (del spike)

- Llega `PreToolUse` con `tool_name: "AskUserQuestion"` y `tool_input = { questions: [{ question, header, options: [{ label, description }], multiSelect }] }`.
- Claude **espera** la respuesta del hook (límite: `timeout` del grupo) y **no muestra su propio diálogo mientras espera**.
- `answers` es un mapa *texto de la pregunta → respuesta*: una etiqueta; en `multiSelect`, etiquetas unidas por `", "`; o texto libre.
- Si el hook responde `{}` (o falla), Claude muestra su diálogo normal.

## Arquitectura

### Main (`src/main/claude/`)

- **`hook-events.ts`**: esquema zod de `AskUserQuestion` (`tool_input`): 1–4 preguntas; 2–4 opciones; `question` ≤ 500, `header` ≤ 60, `label` ≤ 120, `description` ≤ 300 caracteres. Una entrada que no cumpla → el bridge responde un 200 vacío al momento (Claude pregunta como siempre).
- **`question-broker.ts`** (nuevo, según el modelo de `permission-broker.ts`):
  - Guarda las preguntas pendientes por `tool_use_id` con `session_id`, proyecto (como los permisos), `tool_input` validado y el `respond` de la petición HTTP retenida; cola por orden de llegada.
  - `answer(id, selections)` construye `answers` desde las preguntas guardadas y responde `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers } } }`.
  - `release(id)` responde `{}`.
  - Suelta (responde `{}` y elimina) con `PostToolUse`/`PostToolUseFailure` del mismo `tool_use_id`, y con `Stop`, `StopFailure`, `SessionEnd` o `UserPromptSubmit` de la misma sesión; al cerrar la app suelta todas.
- **`claude-bridge.ts`**: para `PreToolUse` con `tool_name === 'AskUserQuestion'` retiene la respuesta y la entrega al broker (como `PermissionRequest`); el resto de `PreToolUse` sigue respondiéndose al momento.
- **`hook-installer.ts`**: añade (y repara) un grupo `PreToolUse` con `matcher: "AskUserQuestion"`, `type: "http"`, la misma URL y token del bridge, `timeout: 3600`. La detección de hooks instalados/desactualizados lo incluye; desinstalar lo quita. Los grupos de otras apps no se tocan.
- **`claude-integration.ts`**: con preguntas pendientes, toast de Windows ("Claude te pregunta" + proyecto; clic → abre el panel de la pregunta) y aviso al estado del notch.

### Estado del notch

- `NotchState.question: boolean` (hay al menos una pregunta pendiente). `notchMode` → `alert` con `attention || question || reminderDue || mailAlert`, también en `mini`/`hidden` (como los demás avisos). **Prioridad: permiso y pregunta al mismo nivel (por orden de llegada)** > recordatorio > correo.
- `openingView`: si la primera pendiente es una pregunta → vista `question`.
- Nuevo modo/vista `question` en `PANEL_MODES`; `back` → `expanded`.

### IPC (todo solo notch; `registerIpc`, guards y zod de entrada y salida)

| Canal / evento | Entrada | Salida |
|---|---|---|
| evento `claude:questions` | — | `PendingQuestionView[] = [{ id, project, arrivedAt, questions: [{ question, header, multiSelect, options: [{ label, description }] }] }]` |
| `claude:get-questions` | — | `PendingQuestionView[]` |
| `claude:answer` | `{ id, answers: [{ selected: number[], other?: string }] }` (uno por pregunta, en orden) | `'sent' \| 'gone'` |
| `claude:release-question` | `{ id }` | `null` (y lleva a la sesión como el botón de permisos) |

Validación en main: `answers.length === questions.length`; en preguntas de opción única, exactamente una opción **o** `other`; en `multiSelect`, al menos una opción y/o `other`; índices dentro de rango y sin repetir; `other` recortado, 1–500 caracteres, sin saltos de línea. `other` se envía tal cual; en `multiSelect` se añade al final de las etiquetas unidas por `", "`. El renderer nunca envía textos de preguntas ni etiquetas.

### Notch (`src/renderer/notch/claude/`)

- **Aviso en la cápsula**: icono de Claude + "**Claude te pregunta** · *proyecto*" (ES) / "**Claude asks** · *project*" (EN), hasta que se conteste o deje de estar pendiente.
- **Panel `QuestionCard`** (520×504, ventana 582, medido con capturas):
  - Cabecera: proyecto y "1 de N" si hay varias pendientes.
  - Por pregunta: `header` como etiqueta, el texto de la pregunta y sus opciones: radio (opción única) o casillas (`multiSelect`), con etiqueta y descripción; siempre **"Otro…"** con campo de texto. Varias preguntas una debajo de otra con desplazamiento (o en pasos si las capturas lo aconsejan).
  - Pie: **"Responder en Claude"** (suelta y lleva a la sesión) y **"Enviar"** (deshabilitado hasta que todas tengan respuesta).
  - Teclado: flechas entre opciones, Espacio marca, Tab entre preguntas, **Ctrl+Enter** envía; **Esc cierra sin contestar** (la pregunta sigue pendiente y el aviso vuelve).
  - Tras enviar: "Respuesta enviada" ~1 s y se cierra (o pasa a la siguiente pendiente). Si ya no estaba pendiente: "Esta pregunta ya no está pendiente".
- i18n ES/EN; tokens de `DESIGN.md`; el texto de Claude se pinta siempre como texto.

## Seguridad y privacidad

1. Solo la ventana del notch puede contestar o soltar; entradas validadas con zod en main.
2. Main construye `answers` a partir de las preguntas que recibió del hook; el renderer solo envía posiciones y texto libre.
3. El texto de preguntas, opciones y respuestas **nunca** se escribe en el log (solo ids, recuentos y resultados).
4. El bridge sigue escuchando solo en `127.0.0.1` con su token.
5. Ninguna respuesta se envía sin una acción explícita del usuario (clic en Enviar o Ctrl+Enter).

## Pruebas

- **Unitarias**: esquema de `AskUserQuestion` (límites, entradas inválidas → `{}`); broker (contestar, soltar, liberación por cada evento de la sesión y por `tool_use_id`, cola de varias sesiones, cierre de la app); construcción de `answers` (única, múltiple con `", "`, "Otro" solo y combinado); validación de `claude:answer`; instalador (añade, repara y quita el grupo sin tocar otros); estado del notch (prioridad, `mini`/`hidden` → aviso, vista que se abre); guards IPC; el log no contiene textos.
- **E2E** con el bridge real y un cliente de hook simulado (como `claude.spec`): llega una pregunta → aviso → elegir y enviar → el hook recibe `allow` + `answers`; `multiSelect`; "Otro"; "Responder en Claude" → `{}`; `Stop` de la sesión → se suelta y desaparece; capturas ES/EN del aviso y del panel (1 pregunta y 4 preguntas).
- **Manual (usuario)**: una pregunta real de Claude contestada desde el notch.

## Criterios de aceptación

1. Una pregunta de Claude aparece en el notch (también en `mini` u oculta) y con toast en ≤ 1 s.
2. Elegir y enviar desde el notch hace que Claude continúe con esa respuesta sin abrir su ventana.
3. "Otro" envía texto libre; `multiSelect` envía varias opciones.
4. "Responder en Claude" devuelve la pregunta a la ventana de Claude.
5. Si la sesión sigue sin respuesta (interrupción, nuevo prompt, fin), la pregunta desaparece del notch.
6. Ningún texto de preguntas o respuestas aparece en el log.

## Fuera de alcance

Aprobación de planes (`ExitPlanMode`), formularios MCP (`Elicitation`), opciones "permitir siempre" de los permisos, CLI y VS Code (no probados; el diseño no depende de la superficie, pero solo se verifica la app de escritorio).
