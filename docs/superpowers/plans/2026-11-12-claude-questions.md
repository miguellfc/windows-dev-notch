# Preguntas de Claude Code en el notch — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contestar desde el notch las preguntas de opción múltiple de Claude Code (`AskUserQuestion`), con aviso en la cápsula y toast, igual que los permisos.

**Architecture:** Un grupo de hook `PreToolUse` propio (`matcher: "AskUserQuestion"`, ruta `/hook/question`, `timeout` 3600) llega al bridge, que retiene la respuesta y la entrega a un `question-broker` (modelo de `permission-broker`). El notch muestra la pregunta en un panel nuevo; main construye `answers` y responde `allow` + `updatedInput`, o suelta con `{}`.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Zustand, zod 4, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-12-claude-questions-design.md` (y `docs/spikes/askuserquestion-findings.md`).

## Global Constraints

- `tool_input` de `AskUserQuestion`: 1–4 preguntas; 2–4 opciones; `question` ≤ 500, `header` ≤ 60, `label` ≤ 120, `description` ≤ 300 caracteres. Si no cumple → `{}` al momento.
- Respuesta: `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers } } }`; `answers[question] =` etiqueta | etiquetas unidas por `", "` (`multiSelect`) | texto libre; en `multiSelect`, el texto libre va al final de la lista unida.
- `other`: recortado, 1–500 caracteres, sin saltos de línea. Opción única: exactamente una opción **o** `other`. `multiSelect`: ≥ 1 opción y/o `other`. Índices en rango y sin repetir. `answers.length === questions.length`.
- Soltar (`{}`) con `PostToolUse`/`PostToolUseFailure` del mismo `tool_use_id`; `Stop`, `StopFailure`, `SessionEnd`, `UserPromptSubmit` de la misma sesión; al cerrar la app.
- El grupo general de `PreToolUse` (2 s, ruta `/hook`) **sigue respondiendo `{}` al momento** también para `AskUserQuestion`; solo `/hook/question` se retiene.
- Prioridad de avisos: permiso = pregunta (orden de llegada) > recordatorio > correo; los avisos se muestran también en `mini`/`hidden`.
- Interacción: clic y teclado (flechas, Espacio, Tab, Ctrl+Enter); Esc cierra sin contestar. Nada se envía sin acción explícita.
- Log: nunca textos de preguntas, opciones ni respuestas (solo ids, recuentos, resultados). i18n ES/EN; tokens de `DESIGN.md`; ≥ 24 px.
- Sin commits por tarea. No modificar `eslint.config.mjs`. Nunca manejar el escritorio del usuario ni escribir en el `~/.claude/settings.json` real en pruebas (rutas aisladas como en `claude.spec`).

## Review Focus

1. **Dos peticiones para la misma pregunta** (grupo general `/hook` y grupo `/hook/question`) → la general responde `{}` al momento y solo la de `/hook/question` se retiene (Task 3).
2. **El usuario contesta en la ventana de Claude o interrumpe** → la pregunta desaparece del notch y no queda una petición colgada (Task 2, Task 4).
3. **Respuesta enviada cuando la petición ya se cerró** (timeout o socket cerrado) → `gone`, sin excepción (Task 2).
4. **Pregunta y permiso a la vez de sesiones distintas** → los dos avisos se atienden por orden de llegada sin perder ninguno (Task 5).
5. **Etiquetas con comas o texto libre con comas en `multiSelect`** → se envía tal cual (Claude acepta texto); documentar que no se escapa (Task 1).

---

### Task 1: Esquemas y construcción de respuestas

**Files:** Modify `src/shared/claude/hook-events.ts` (y `types.ts`); Create `src/shared/claude/questions.ts`; tests `tests/unit/shared/claude-questions.test.ts`, `hook-events.test.ts`.

**Interfaces — Produces:** `askUserQuestionInputSchema` (límites de Global Constraints); `parseHookEvent` conserva, solo para `PreToolUse` con `tool_name === 'AskUserQuestion'`, `event.askUserQuestion` validado (o `null` si no cumple) y `event.toolUseId`; `PendingQuestion = { id, project, questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`; `questionAnswerInputSchema { id, answers: [{ selected: number[], other?: string }] }`; `buildAnswers(questions, answers): Record<string, string> | null` (null si no cumple las reglas); `questionResponseBody(questions, answers): string`.

- [ ] Tests: límites (1/4 preguntas, 2/4 opciones, longitudes en el borde y fuera); `buildAnswers` única, múltiple (`", "`), `other` solo, `other` + opciones en `multiSelect`, índices repetidos o fuera de rango → null, opción única con dos → null, `other` con salto de línea o > 500 → null; `questionResponseBody` con el JSON exacto de Global Constraints.
- [ ] RED → GREEN.

### Task 2: Broker de preguntas

**Files:** Create `src/main/claude/question-broker.ts`; test `tests/unit/main/question-broker.test.ts`.

**Interfaces — Consumes:** Task 1, `PendingReply` de `permission-broker.ts`. **Produces:** `createQuestionBroker({ newId, now, sessionName, onChange })` → `{ hold(e: HookEvent, reply: PendingReply): void; answer(id, answers): 'sent' | 'gone' | 'invalid'; release(id): boolean; observe(e: HookEvent): void; releaseAll(): void; pending(): PendingQuestion[] }`.

- [ ] Tests: `hold` sin `askUserQuestion` válido → `send('{}')` al momento; `answer` válido → `send(questionResponseBody)` y desaparece; inválido → `'invalid'` sin enviar; `release` → `send('{}')`; `observe` de `PostToolUse` con el mismo `tool_use_id` y de cada evento de fin de sesión → suelta solo las de esa sesión; `reply.onClose` (socket cerrado) → la quita y `answer` posterior → `'gone'`; cola por orden de llegada; `releaseAll`; `onChange` en cada cambio.
- [ ] RED → GREEN.

### Task 3: Bridge e instalador de hooks

**Files:** Modify `src/main/claude/claude-bridge.ts`, `src/main/claude/hook-installer.ts`; tests `tests/unit/main/claude-bridge.test.ts`, `hook-installer.test.ts`.

**Interfaces — Produces:** ruta `POST /hook/question` (mismo token): `PreToolUse` de `AskUserQuestion` → retiene y entrega con `reply`; cualquier otro evento en esa ruta → `{}`. `/hook` sin cambios (responde al momento). El instalador añade/repara el grupo `{ matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: <bridge>/hook/question, headers/token como los demás, timeout: 3600 }] }`; `hookStatus` lo exige; desinstalar lo quita; los grupos de otras apps no se tocan.

- [ ] Tests: `/hook` con `AskUserQuestion` → 200 `{}` inmediato (Review Focus 1); `/hook/question` → retenido hasta `reply.send`; token inválido → 403 como `/hook`; instalador: plan de instalación con el grupo nuevo, `outdated` si falta, desinstalar lo elimina, otras entradas intactas.
- [ ] RED → GREEN.

### Task 4: Integración, IPC y toast

**Files:** Modify `src/main/claude/claude-integration.ts` (o `claude-service.ts`, donde viva el broker de permisos), `src/shared/ipc/channels.ts`, `contract.ts`, `src/main/index.ts`; tests de la integración, `claude-ipc`/`register-ipc`, `ipc-contract`.

**Interfaces — Produces:** evento `claude:questions` (`PendingQuestion[]`) al notch; `claude:get-questions`; `claude:answer` → `'sent' | 'gone'` (`'invalid'` → `INVALID_INPUT`); `claude:release-question { id }` → `null` y trae la sesión al frente como el botón de permisos; toast "Claude te pregunta" / "Claude asks" + proyecto (clic → abre la vista `question`); dispatch al estado del notch `{ type: 'question', on }`.

- [ ] Tests: el broker recibe `hold` desde el bridge y `observe` de todos los eventos; guards solo notch; zod de entrada y salida; toast una vez por pregunta; `releaseAll` al cerrar; el log no contiene textos (Review Focus 2 y 3 en el cableado).
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 5: Estado del notch

**Files:** Modify `src/shared/notch/state.ts`, `geometry.ts`, `src/shared/ipc/contract.ts` (`notchModeSchema`), controlador del notch; tests `notch-state`, `notch-controller`, `notch-geometry`.

**Interfaces — Produces:** `NotchState.question`; evento `{ type: 'question'; on: boolean }`; `notchMode` → `alert` con `attention || question || reminderDue || mailAlert` (también `mini`/`hidden`); modo/vista `question` en `PANEL_MODES`; `openingView` elige `permission` o `question` según la que llegó antes (el controlador pasa el orden; si no lo tiene, la primera pendiente del broker conjunto); `CAPSULE_SIZES.question` provisional (Task 6 lo fija).

- [ ] Tests: pregunta en `compact`/`mini`/`hidden` → `alert`; abrir → vista `question`; permiso + pregunta → la primera en llegar se abre y luego la otra (Review Focus 4); `back` → `expanded`; contestar la última → sale de `alert`.
- [ ] RED → GREEN.

### Task 6: Aviso y panel `QuestionCard`

**Files:** Create `src/renderer/notch/claude/QuestionCard.tsx` (+ store en `src/renderer/shared/`); Modify `NotchApp.tsx`, `AlertCapsule.tsx` (texto de pregunta), `messages.ts`, `geometry.ts` (tamaño medido).

- [ ] Aviso: icono de Claude + "Claude te pregunta · proyecto".
- [ ] Panel según el spec: cabecera (proyecto, "1 de N"), preguntas con radio/casillas y "Otro…" con campo de texto, pie "Responder en Claude" / "Enviar" (deshabilitado hasta completar), "Respuesta enviada" ~1 s, "Esta pregunta ya no está pendiente".
- [ ] Teclado: flechas, Espacio, Tab, Ctrl+Enter; Esc cierra sin contestar; foco inicial en la primera opción.
- [ ] Tamaño medido con Playwright (1 pregunta de 4 opciones y 4 preguntas; desplazamiento sin recortar cabecera ni pie).
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 7: E2E, documentación y capturas

**Files:** Modify `tests/e2e/claude.spec.ts` (o nuevo `claude-questions.spec.ts` con el mismo `launch`).

- [ ] Cliente de hook simulado contra el bridge real: pregunta → aviso → elegir y enviar → la respuesta HTTP es `allow` + `answers` correctos; `multiSelect`; "Otro"; "Responder en Claude" → `{}`; `Stop` de la sesión → la petición recibe `{}` y el panel desaparece; la misma pregunta por `/hook` → `{}` inmediato. Capturas `claude-question-alert-es.png`, `claude-question-es.png`, `claude-question-en.png`, `claude-question-4q-es.png`.
- [ ] `npm run build` y `npm run test:e2e` → PASS.

### Task 8: Verificación y documentación

- [ ] Revisión de la rama completa con subagente.
- [ ] DESIGN.md (aviso y panel de pregunta) y PRD (preguntas de Claude hechas).
- [ ] Manual (usuario): reinstalar los hooks desde Control Center (por el grupo nuevo) y contestar una pregunta real de Claude desde el notch.
