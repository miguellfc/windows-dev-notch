# M4 · Recordatorios — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear recordatorios en segundos desde el notch o el Control Center y recibir a su hora alerta en la cápsula, toast y sonido, con posponer y completar.

**Architecture:** Lógica pura en `src/shared/reminders/` (esquema, analizador, cálculo de horas). En main, `src/main/reminders/` sigue el patrón de `src/main/claude/`: store JSON → `RemindersService` (operaciones) → `ReminderScheduler` (un temporizador + comprobación de 60 s) → `reminders-integration.ts` (adaptador Electron: `powerMonitor`, `Notification`, eventos IPC, `notch.dispatch({ type: 'reminders', due })`). El notch añade la integración `reminders` (vista y modo de 420×320) y la alerta; el Control Center, una página.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Motion, Zustand, zod 4, Lucide, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-10-m4-reminders-design.md`.

## Global Constraints

- Texto: 1–200 caracteres tras recortar espacios, sin caracteres de control (`\p{Cc}`, `\p{Cf}`). Máximo 500 recordatorios no `done`. Los `done` de más de 7 días se purgan al arrancar.
- Repetición: `'none' | 'daily' | 'weekdays'` (lunes a viernes). `localTime` `HH:mm` obligatorio si `repeat ≠ 'none'`.
- Posponer: `settings.reminders.snoozeMinutes ∈ {5, 10, 15, 30}`, por defecto 10. Sonido: `settings.reminders.sound`, por defecto `true`. `SETTINGS_VERSION` pasa de 1 a 2.
- Comprobación de seguridad cada 60 000 ms; temporizador máximo 2 147 483 647 ms.
- Chips: `'15m'` = ahora + 15 min, `'1h'` = ahora + 60 min, `'tomorrow-9'` = mañana a las 09:00 locales.
- Toast con `silent: true`; el sonido es un tono sintetizado con Web Audio en el renderer del notch (sin archivo, para no tocar la CSP), solo si `sound` y el modo no es `hidden`.
- El log nunca contiene el texto de un recordatorio (solo `id`, `state`, recuentos).
- `reminders:update` solo desde el Control Center; el resto, notch y Control Center.
- Variables de prueba solo si `!app.isPackaged`: `NOTCH_USER_DATA_DIR` (ya existe) y `NOTCH_TEST_CLOCK=1`.
- Estilo Obsidian, Ámbar Espera para lo vencido, iconos Lucide, i18n ES/EN, escala 11/12.5/13/15 px, `prefers-reduced-motion`.
- Sin commits por tarea (el usuario aprueba los commits al final). No modificar `eslint.config.mjs`. No push.

## Review Focus

1. **El PC duerme durante el vencimiento** → al reanudar vence **una vez** (el temporizador, `resume` y la comprobación de 60 s no duplican toast ni sonido) (Task 5).
2. **"16:00 standup" escrito a las 16:00:30, o justo a las 16:00** → mañana a las 16:00; nunca un recordatorio ya vencido al crearlo (Task 2).
3. **Posponer un recordatorio que se repite** → solo retrasa esa ocurrencia; al completarlo, la siguiente se calcula desde `localTime`, no desde la hora pospuesta (Task 4).
4. **Editar en el Control Center con una fecha pasada** → se rechaza con `INVALID_INPUT` y el formulario lo explica; no vence de golpe (Task 4, Task 9).
5. **`reminders.json` corrupto o de una versión más nueva** → corrupto: cuarentena y aviso una vez; más nuevo: solo lectura, nunca se sobrescribe (Task 3).

---

### Task 0: Prueba de acciones del toast en Windows (desechable)

**Files:** Create `spikes/m4/toast-actions/` (fuera del lint), `docs/spikes/m4-toast-findings.md`.

- [ ] Script Electron mínimo: `new Notification({ title, body, actions: [{ type: 'button', text: 'Posponer' }, { type: 'button', text: 'Completar' }] })` y, aparte, la variante `toastXml` con `<actions>`. Registrar si aparecen los botones y si llega `action` (índice) u otro evento al pulsar, con la app en primer y en segundo plano.
- [ ] Documentar el resultado: **A** (botones con evento → se usan) o **B** (plan B de la spec: toast sin botones; click abre la vista de recordatorios). Las tareas 6 y 10 siguen la opción documentada.

### Task 1: Esquema y ajustes

**Files:** Create `src/shared/reminders/schema.ts`; Modify `src/shared/settings/schema.ts`, `src/main/services/settings-migrations.ts`; tests `tests/unit/shared/reminders-schema.test.ts`, `settings-schema.test.ts`, `tests/unit/main/settings-migrations.test.ts`.

**Interfaces — Produces:** `REMINDER_TEXT_MAX = 200`, `REMINDERS_ACTIVE_MAX = 500`; `reminderTextSchema`; `reminderSchema` / `Reminder` (campos de la spec); `remindersFileSchema` (`{ version: 1, reminders }`); `reminderPresetSchema = z.enum(['15m', '1h', 'tomorrow-9'])` / `ReminderPreset`; `createReminderInputSchema = z.union([z.strictObject({ input: z.string().max(400) }), z.strictObject({ text: reminderTextSchema, preset: reminderPresetSchema })])` / `CreateReminderInput`; `updateReminderInputSchema = z.strictObject({ id: z.uuid(), text?, dueAt?: z.iso.datetime(), repeat? })` con al menos un campo además de `id` / `UpdateReminderInput`; `Settings.reminders: { snoozeMinutes: 5 | 10 | 15 | 30; sound: boolean }`; migración `1 → 2` que añade los valores por defecto.

- [ ] Tests: texto con caracteres de control o de 201 caracteres → inválido; `repeat: 'daily'` sin `localTime` → inválido; `update` solo con `id` → inválido; settings v1 migra a v2 con `{ snoozeMinutes: 10, sound: true }`; `snoozeMinutes: 7` → inválido; `settingsPatchSchema` acepta `{ reminders: { snoozeMinutes: 15, sound: false } }`.
- [ ] RED → implementar → GREEN.

### Task 2: Cálculo de horas y analizador

**Files:** Create `src/shared/reminders/time.ts`, `src/shared/reminders/parse.ts`; tests `tests/unit/shared/reminders-time.test.ts`, `reminders-parse.test.ts`.

**Interfaces — Produces:**
- `atLocalTime(day: Date, hhmm: string): Date` (si la hora no existe por DST, la siguiente hora válida).
- `nextOccurrence(repeat: 'daily' | 'weekdays', localTime: string, after: Date): Date` (estrictamente posterior a `after`).
- `presetDueAt(preset: ReminderPreset, now: Date): Date`.
- `parseReminder(input: string, now: Date): ParsedReminder | { error: 'empty-text' | 'no-time' | 'too-long' }`; `ParsedReminder = { text: string; dueAt: Date; repeat: Reminder['repeat']; localTime?: string }`.

- [ ] Tests (zona horaria fija `Europe/Madrid`: `process.env.TZ` en el setup del archivo de test):
  - `en 30 min revisar PR` / `in 30 min review PR` / `en 2 h …` / `in 1 hour …` → `now + N`, texto `revisar PR`.
  - `16:00 standup` a las 15:59 → hoy; a las 16:00:00 y a las 16:00:30 → mañana. `4pm x` → 16:00; `12am x` → 00:00.
  - `mañana 9:00 x` / `tomorrow 9:00 x` → mañana 09:00.
  - `diario 9:00 x` / `daily 9:00 x` → `repeat: 'daily'`, `localTime: '09:00'`; `laborables 9:30 x` / `weekdays 9:30 x` un viernes a las 10:00 → lunes 09:30.
  - Mayúsculas y acentos opcionales (`Manana`, `EN 5 MIN`); `16:00` sin texto → `empty-text`; `revisar PR` → `no-time`; texto de 201 caracteres → `too-long`; `25:00 x` → `no-time`.
  - DST: `nextOccurrence('daily', '02:30', …)` el día del adelanto (29-03-2026) → 03:00; el día del retraso (25-10-2026) vence a las 02:30 una sola vez.
- [ ] RED → implementar (expresiones regulares ancladas al principio; sin librerías de fechas) → GREEN.

### Task 3: Store de recordatorios

**Files:** Create `src/main/reminders/reminders-store.ts`, `src/main/services/fs-atomic.ts` (mover `writeFileAtomic` y `readTextFile` desde `src/main/claude/hook-installer.ts` y actualizar sus imports); test `tests/unit/main/reminders-store.test.ts`.

**Interfaces — Produces:** `createRemindersStore({ file: string; logger: Logger; now: () => Date })` → `{ load(): Promise<'ok' | 'quarantined' | 'read-only'>; all(): readonly Reminder[]; write(next: readonly Reminder[]): Promise<void> }`. `write` se serializa y valida con `remindersFileSchema`; en `read-only` lanza `ExposedIpcError('READ_ONLY', …)`.

- [ ] Tests: archivo ausente → `ok` y lista vacía; JSON o esquema inválido → se renombra a `reminders.corrupt-<fecha>.json`, devuelve `quarantined` y lista vacía; `version: 2` → `read-only` y el archivo queda intacto tras un `write` fallido; dos `write` simultáneos → el archivo final es el del segundo; el log no contiene el texto. Los tests de `hook-installer` siguen pasando tras mover las funciones.
- [ ] RED → implementar → GREEN.

### Task 4: RemindersService

**Files:** Create `src/main/reminders/reminders-service.ts`; test `tests/unit/main/reminders-service.test.ts`.

**Interfaces — Consumes:** Tasks 1–3. **Produces:** `createRemindersService({ store, now: () => Date, newId: () => string, snoozeMinutes: () => number, onChange: () => void })` →
`{ list(): Reminder[]; create(i: CreateReminderInput): Promise<Reminder>; update(i: UpdateReminderInput): Promise<Reminder>; snooze(id: string): Promise<Reminder>; complete(id: string): Promise<Reminder>; remove(id: string): Promise<void>; markDue(): Promise<Reminder[]>; markMissedOnStart(): Promise<Reminder[]>; purgeDone(): Promise<void>; nextDueAt(): Date | null; attentionCount(): number }`.

- [ ] Tests:
  - `create({ input })` usa `parseReminder`; un error de análisis → `ExposedIpcError('INVALID_INPUT', <código>)`; `create({ text, preset })` usa `presetDueAt`; el activo número 501 → `INVALID_INPUT`.
  - `snooze` → `state: 'pending'`, `dueAt = now + snoozeMinutes()`; en uno repetido conserva `repeat` y `localTime`.
  - `complete` de `none` → `done` + `completedAt`; de uno repetido → `pending` con `nextOccurrence(repeat, localTime, now)`.
  - `update` con `dueAt` ≤ `now` → `INVALID_INPUT`; cambiar `repeat` a `daily` fija `localTime` a partir del `dueAt` resultante.
  - Id inexistente → `NOT_FOUND` en `update`, `snooze`, `complete` y `remove`.
  - `markDue` pasa a `due` todos los `pending` con `dueAt ≤ now` y devuelve solo esos; una segunda llamada inmediata devuelve `[]`.
  - `markMissedOnStart`: `none` vencido → `missed`; repetido vencido → `missed` una sola vez aunque se perdieran varias ocurrencias.
  - `attentionCount` = `due` + `missed`; `nextDueAt` = menor `dueAt` entre los `pending`; `onChange` tras cada escritura.
- [ ] RED → implementar → GREEN.

### Task 5: ReminderScheduler

**Files:** Create `src/main/reminders/reminder-scheduler.ts`; test `tests/unit/main/reminder-scheduler.test.ts`.

**Interfaces — Produces:** `createReminderScheduler({ service, now, timers: { setTimeout, clearTimeout, setInterval, clearInterval }, onFired: (batch: Reminder[]) => void, onMissed: (missed: Reminder[]) => void, safetyIntervalMs = 60_000 })` → `{ start(): Promise<void>; reschedule(): void; check(): Promise<void>; dispose(): void }`. `start` = `purgeDone` + `markMissedOnStart` (→ `onMissed` si hay alguno) + `reschedule` + intervalo. `check` = `markDue` (→ `onFired` si hay alguno) + `reschedule`. Las llamadas a `check` se serializan.

- [ ] Tests con temporizadores falsos: vence a su hora y llama a `onFired` una vez con todos los vencidos juntos; `reschedule` tras crear uno más temprano adelanta el temporizador; `check()` desde `resume`, temporizador e intervalo en el mismo instante → un solo `onFired`; un reloj que salta 2 h hacia delante lo detecta el intervalo; un vencimiento a 40 días acota el temporizador a 2 147 483 647 ms y se rearma; `dispose` cancela todo.
- [ ] RED → implementar → GREEN.

### Task 6: Toast, IPC y cableado en main

**Files:** Create `src/main/reminders/reminder-toast.ts`, `reminders-ipc.ts`, `reminders-integration.ts`; Modify `src/shared/ipc/channels.ts`, `contract.ts`, `api.ts` (namespace `reminders`), el preload si enumera namespaces, `src/main/index.ts`, `src/shared/i18n/messages.ts`; tests `tests/unit/main/reminder-toast.test.ts`, `reminders-ipc.test.ts`, `register-ipc.test.ts`, `tests/unit/shared/ipc-contract.test.ts`.

**Interfaces — Produces:** canales `reminders:list` (→ `{ reminders: Reminder[]; notice: 'quarantined' | 'read-only' | null }`), `reminders:create`, `reminders:update`, `reminders:snooze`, `reminders:complete`, `reminders:delete` (`{ id: z.uuid() }`); eventos `reminders:changed` (mismo payload que `list`) y `reminders:fired` (`{ count: number }`, solo al notch; dispara el sonido); `remindersChannelGuards({ fromNotch, fromControlCenter })`; `createReminderToast({ notify, translate })` → `{ fired(batch: Reminder[], snoozeMinutes: number): void; missed(count: number): void }`.

- [ ] Tests: toast de uno → título "Recordatorio", cuerpo = su texto; de tres → "3 recordatorios" con los dos primeros textos; perdidos → "Tienes N recordatorios perdidos"; acciones según Task 0 (A: Posponer N min y Completar llaman al servicio con los ids de la tanda; B: sin botones); click en el cuerpo → abre el notch en `reminders`. Guards: `reminders:update` desde el notch → `FORBIDDEN`; entradas inválidas → `INVALID_INPUT`.
- [ ] Cableado en `index.ts` tras `settings.load()`: store en `userData/reminders.json`; `powerMonitor.on('resume')` y `on('unlock-screen')` → `check()`; tras cada cambio, `notch.dispatch({ type: 'reminders', due: service.attentionCount() > 0 })` y `reminders:changed` a notch y Control Center; `onFired` → toast + `reminders:fired`; `onMissed` → un toast; al salir, `dispose()`.
- [ ] Reloj de prueba: si `!app.isPackaged && process.env['NOTCH_TEST_CLOCK'] === '1'`, `now = () => new Date(Date.now() + offset)` y `globalThis.__notchTestClock = { advance(ms) { offset += ms; return scheduler.check() } }`.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 7: Estado del notch — alerta e integración

**Files:** Modify `src/shared/integrations/registry.ts`, `src/shared/notch/state.ts`, `geometry.ts`, `src/shared/ipc/contract.ts` (`notchModeSchema`), `src/main/windows/notch-controller.ts` si hace falta; tests `notch-state.test.ts`, `notch-geometry.test.ts`, `notch-controller.test.ts`.

**Interfaces — Produces:** `integrationIds = ['terminal', 'reminders']`; `NotchMode` + `'reminders'`; `CAPSULE_SIZES.reminders = { width: 420, height: 320 }`; `PANEL_MODES` incluye `reminders`; `NotchState.reminderDue: boolean`; evento `{ type: 'reminders'; due: boolean }`.

- [ ] Tests: `reminders` encendido en compact → `alert`; expandir con `reminderDue` sin `attention` → vista `reminders`; con ambos → `permission`; apagarlo con la vista `reminders` abierta → sigue abierta; apagarlo en `alert` → `compact`; `hidden` gana; `mini` + `reminderDue` → `alert`; evento repetido devuelve el mismo objeto; el controlador enfoca al abrir `reminders` y crece antes de animar.
- [ ] RED → implementar → GREEN.

### Task 8: Renderer del notch

**Files:** Create `src/renderer/shared/reminders-store.ts`, `src/renderer/notch/reminders/RemindersView.tsx`, `ReminderComposer.tsx`, `ReminderList.tsx`, `ReminderAlert.tsx`, `chime.ts`; Modify `NotchApp.tsx`, `IntegrationRow.tsx`, `claude/AlertCapsule.tsx` (punto ámbar si también hay recordatorio), `messages.ts`; test `tests/unit/shared/i18n.test.ts`.

- [ ] Store: `useReminders` + `bindReminders()` con el patrón de `claude-store.ts`.
- [ ] Composer: foco al abrir; vista previa en vivo con `parseReminder(value, new Date())` ("Revisar PR · hoy 16:30", "mañana 9:00", ↻ si se repite) o el motivo del error en gris; chips `+15 min`, `+1 h`, `Mañana 9:00` (deshabilitados sin texto); Enter crea; Esc con texto lo vacía y sin texto vuelve a la fila (`notch:back`); un error de main se muestra bajo el campo.
- [ ] Lista: vencidos y perdidos primero, con **Posponer N min** y **Completar**; después los `pending` de hoy y mañana con hora, texto (siempre como texto) y ↻; Completar y Borrar al pasar el ratón o con foco; enlace "Ver todos" → `app:open-control-center`. Aviso si `notice` no es `null`.
- [ ] Alerta: icono `AlarmClock` + texto truncado o "N recordatorios", en Ámbar Espera; si también hay un permiso de Claude, se muestra la alerta de Claude con un punto ámbar.
- [ ] Fila de integraciones: icono `AlarmClock` con insignia numérica (`attentionCount`).
- [ ] `chime.ts`: `playChime(): void`, dos tonos sinusoidales cortos (880 Hz y 660 Hz, 120 ms cada uno, ataque y caída suaves, ganancia 0,15) con `AudioContext`; se llama al recibir `reminders:fired` si `settings.reminders.sound` y el modo no es `hidden`.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 9: Control Center — página "Recordatorios"

**Files:** Create `src/renderer/control-center/RemindersPage.tsx`; Modify `ControlCenterApp.tsx` (página `reminders`, icono `AlarmClock`), `messages.ts`.

- [ ] Grupos *Vencidos*, *Próximos*, *Se repiten*, *Completados (últimos 7 días)*; campo de creación con la misma vista previa; editar texto, fecha y hora (`<input type="datetime-local">`) y repetición; error de fecha pasada junto al campo; borrar; ajustes de posponer (`Segmented` 5/10/15/30) y sonido (`Switch`) con `settings:update`.
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 10: E2E y capturas

**Files:** Create `tests/e2e/reminders.spec.ts` (mismo `launch` que `claude.spec.ts`, con `NOTCH_TEST_CLOCK=1` y un `userData` temporal).

- [ ] Casos: abrir la integración y crear "en 30 min revisar PR" con Enter y otro con el chip `+15 min` → ambos en la lista; `app.evaluate(() => globalThis.__notchTestClock.advance(31 * 60_000))` → la cápsula entra en `alert` con "2 recordatorios" en < 1 s; expandir → vista `reminders` con los vencidos; Posponer → sale de vencidos; Completar → desaparece y, sin vencidos, la cápsula vuelve a `compact`; arrancar con un `reminders.json` que tiene un vencido de ayer → alerta de perdido al arrancar; Control Center: editar a una fecha pasada muestra el error; capturas `test-results/m4-*.png` (fila con el icono, composer con vista previa, alerta, vista con vencidos, Control Center).
- [ ] `npm run test:e2e` → PASS (incluidos app, terminal y claude).

### Task 11: Verificación

- [ ] Revisión de la rama completa con subagente (planificador, DST, guards, logs sin texto).
- [ ] Manual en la máquina real: toast (acciones o plan B), sonido, suspender y reanudar con un recordatorio pendiente (criterio 23), perdidos al arrancar con la app instalada.
- [ ] RAM en reposo sin integraciones abiertas sigue < 200 MB.
- [ ] Actualizar el PRD (M4: entrada desde la integración, criterios 21–24) y la spec con el resultado de Task 0.
