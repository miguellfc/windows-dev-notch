# Fijar una tarea de Redmine — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fijar una tarea de Redmine desde su detalle. Mientras esté fijada, un icono en la cabecera del panel y en las cabeceras de las vistas del notch abre esa tarea.

**Architecture:** Solo interfaz del notch. La lógica pura (alternar la fijación, cuándo se ve el acceso directo) vive en `src/renderer/shared/redmine/pin.ts`. El estado (`pinned`, `openTarget`) vive en el store de Redmine, y la sesión lo olvida al terminar. Un componente compartido, `PinnedIssueShortcut`, se coloca en cada cabecera. `RedmineView` consume `openTarget` y abre el detalle.

**Tech Stack:** React 19, Tailwind 4, zustand, lucide-react (`Pin`, `PinOff`), vitest (entorno node, sin pruebas de componentes) y WebdriverIO para la e2e de Tauri.

**Spec:** `docs/superpowers/specs/2026-11-22-redmine-pin-design.md`

## Global Constraints

- Sin cambios en ajustes, contratos IPC ni Rust. Sin fixtures de paridad.
- La fijación no persiste: se pierde al cerrar la app, al terminar la sesión de Redmine o al cambiar de cuenta.
- Solo una tarea fijada a la vez.
- Iconos: `Pin` (fijar y acceso directo) y `PinOff` (soltar), 14 px, `strokeWidth={1.8}`, con `headerIconButton`.
- Textos: `redmine.pin.pin` «Fijar tarea» / «Pin issue»; `redmine.pin.unpin` «Soltar tarea» / «Unpin issue»; `redmine.pin.open` «Abrir #{id} {subject}» / «Open #{id} {subject}».
- `data-testid`: `redmine-pin` (botón del detalle, con `aria-pressed`) y `redmine-pinned-shortcut` (acceso directo).
- No hacer commit sin la aprobación del usuario. Nunca push. No editar `eslint.config.mjs` ni los hooks.
- La e2e necesita que el Developer Notch instalado esté cerrado; hay que pedírselo al usuario.

## Review Focus

- **Fijar desde la búsqueda y abrir desde la propia vista de Redmine con otra búsqueda escrita:** se espera que se vacíe la búsqueda y se abra el detalle fijado. Lo cubre la Task 4 (prueba e2e, paso 3b).
- **La lectura falla por red (no por 404):** la tarea sigue fijada. La Task 3 lo resuelve con `findIssue`: solo `ok && !found` suelta.
- **El acceso directo pulsado estando ya en el detalle de otra tarea de Redmine:** se espera que cambie a la fijada. Lo cubre la Task 4 (e2e).
- **Redmine desactivado en el Centro de Control con una tarea fijada:** el acceso directo desaparece. Lo cubre `shortcutShown` (Task 1).
- **Sesión `offline`:** el acceso directo sigue visible y el detalle carga lo que pueda. Lo cubre `shortcutShown` (Task 1).

---

### Task 1: Lógica pura de la fijación y olvido con la sesión

**Files:**
- Create: `src/renderer/shared/redmine/pin.ts`
- Modify: `src/renderer/shared/redmine/session.ts`
- Test: `tests/unit/renderer/redmine-pin.test.ts` (nuevo), `tests/unit/renderer/redmine-session.test.ts`

**Interfaces:**
- Produces:
  - `export interface PinnedIssue { readonly id: number; readonly subject: string }`
  - `togglePin(pinned: PinnedIssue | null, issue: PinnedIssue): PinnedIssue | null`: devuelve `null` si `issue.id === pinned?.id`; si no, devuelve `issue`.
  - `withSubject(pinned: PinnedIssue | null, id: number, subject: string): PinnedIssue | null`: devuelve el mismo objeto si no es esa tarea o si el asunto no cambia.
  - `shortcutShown(pinned: PinnedIssue | null, status: RedmineStatus | undefined, integrations: IntegrationsSettings | null, currentId?: number | null): boolean`: `true` si hay tarea fijada, el estado es `ok` u `offline`, `integrations` no es null, `integrations.redmine.enabled` es true y `currentId !== pinned.id`.
  - `RedmineSessionView` gana `pinned: PinnedIssue | null` y `openTarget: number | null`. `nextRedmineSession` devuelve también `pinned: null, openTarget: null` cuando la sesión termina (en la misma rama `ended` que ya olvida `summary`).

- [ ] **Step 1: Write the failing tests**

En `redmine-pin.test.ts`:
- `togglePin`:
  - `togglePin(null, A)` → `A`;
  - `togglePin(A, A)` → `null`;
  - `togglePin(A, B)` → `B` (fijar otra suelta la anterior).
- `withSubject`:
  - `withSubject(A, A.id, 'nuevo')` → `{ id: A.id, subject: 'nuevo' }`;
  - `withSubject(A, B.id, 'x')` → `A` (mismo objeto, `toBe`);
  - `withSubject(null, 1, 'x')` → `null`.
- `shortcutShown`:
  - es `true` con `ok` y con `offline`;
  - es `false` con `unconfigured`, `auth-error` y `undefined`;
  - es `false` sin tarea fijada;
  - es `false` con `integrations === null` y con `redmine.enabled === false`;
  - es `false` cuando `currentId === pinned.id`.
  - Para las integraciones, usar `defaultSettings().integrations` de `src/shared/settings/schema.ts`.

En `redmine-session.test.ts`, ampliar `withSummary` con `pinned: { id: 7, subject: 'S' }, openTarget: 7`:
- `it('forgets the pinned issue and the open target when the session ends or the account changes')`: con `unconfigured`, `auth-error` y la cuenta `Bob`, `toMatchObject({ pinned: null, openTarget: null })`;
- con `ok` → `offline` de la misma cuenta, `'pinned' in next` es `false`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/renderer/redmine-pin.test.ts tests/unit/renderer/redmine-session.test.ts`
Expected: FAIL (no existe el módulo `pin`; `pinned` no se olvida).

- [ ] **Step 3: Implement `pin.ts` and extend `nextRedmineSession`**

- [ ] **Step 4: Run to verify they pass**

Run: el mismo comando. Expected: PASS.

---

### Task 2: Estado y acciones en el store de Redmine

**Files:**
- Modify: `src/renderer/shared/redmine-store.ts`
- Test: `tests/unit/renderer/redmine-pin-store.test.ts` (nuevo; carga el store por import dinámico con `window.notch` falso, como `work-log-store.test.ts`)

**Interfaces:**
- Consumes: `PinnedIssue`, `togglePin` y `withSubject` (Task 1).
- Produces, en el store:
  - campos `pinned: PinnedIssue | null` (inicial `null`) y `openTarget: number | null` (inicial `null`);
  - `togglePinnedIssue(issue: PinnedIssue): void`;
  - `unpinIssue(id: number): void`: solo suelta si `id` es la tarea fijada;
  - `renamePinnedIssue(id: number, subject: string): void`;
  - `openPinnedIssue(): void`: si hay fijada, pone `openTarget = pinned.id` y llama a `window.notch.notch.openIntegration({ id: 'redmine' })`;
  - `takeOpenTarget(): number | null`: devuelve el destino y lo deja en `null`.

- [ ] **Step 1: Write the failing tests**

- `togglePinnedIssue(A)` y después `togglePinnedIssue(B)` → `pinned` es `B`; de nuevo `togglePinnedIssue(B)` → `null`.
- `unpinIssue(otroId)` no cambia nada; `unpinIssue(A.id)` → `null`.
- `openPinnedIssue()`:
  - sin tarea fijada, no llama a `openIntegration`;
  - con `A` fijada, `openTarget === A.id` y `openIntegration` recibe `{ id: 'redmine' }` una sola vez.
- `takeOpenTarget()` devuelve `A.id` la primera vez y `null` la segunda.
- Un `redmine:state` emitido con `unconfigured` deja `pinned` y `openTarget` en `null` (a través de `bindRedmine()`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/renderer/redmine-pin-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the fields and actions** (funciones exportadas junto a `setRedmineSearching`, con `useRedmine.setState`)

- [ ] **Step 4: Run to verify they pass**

Run: el mismo comando. Expected: PASS.

---

### Task 3: Botón de fijar en el detalle

**Files:**
- Modify: `src/renderer/notch/redmine/RedmineIssueDetail.tsx` (cabecera, línea ~316; `load`, línea ~193)
- Modify: `src/shared/i18n/messages.ts` (las tres claves `redmine.pin.*` en ES y EN, junto a `redmine.view.*`)

**Interfaces:**
- Consumes: `useRedmine((s) => s.pinned)`, `togglePinnedIssue`, `unpinIssue` y `renamePinnedIssue` (Task 2); `PinnedIssueShortcut` (Task 4; en esta task se deja preparado, el acceso directo del detalle se añade en la Task 4).

- [ ] **Step 1: Botón al final de la cabecera**

Un `<button data-testid="redmine-pin" aria-pressed={pinnedHere}>` con `ml-auto`, después del `<h2>` (que ya es `flex-1`, así que basta con colocarlo detrás).
- `pinnedHere = pinned?.id === id`.
- Icono: `PinOff` si `pinnedHere`; si no, `Pin`.
- `aria-label` y `title`: `t(pinnedHere ? 'redmine.pin.unpin' : 'redmine.pin.pin')`.
- Clase: `headerIconButton`, más `text-[color:var(--int)]` cuando `pinnedHere`.
- `onClick`: `togglePinnedIssue({ id, subject: shown?.subject ?? '' })`.

- [ ] **Step 2: Asunto al día y suelta ante un 404**

En `load`:
- si la lectura va bien, llamar a `renamePinnedIssue(id, issueResult.data.subject)`;
- si falla y `useRedmine.getState().pinned?.id === id`, preguntar `window.notch.redmine.findIssue({ id })`. Solo si `answer.ok && !answer.data.found`, llamar a `unpinIssue(id)`. Un fallo de red no suelta la tarea.
- Respetar la guarda `read !== reads.current` antes de soltar.

- [ ] **Step 3: Verificar tipos y lint**

Run: `npm run typecheck && npm run lint`
Expected: sin errores.

---

### Task 4: Acceso directo en las cabeceras y apertura en la vista de Redmine

**Files:**
- Create: `src/renderer/notch/redmine/PinnedIssueShortcut.tsx`
- Modify:
  - `src/renderer/notch/NotchApp.tsx` (`Panel`, antes del botón del engranaje);
  - `src/renderer/notch/gmail/GmailView.tsx` y `src/renderer/notch/gmail/MessageReader.tsx`;
  - `src/renderer/notch/notes/NotesView.tsx` (solo la cabecera de la lista);
  - `src/renderer/notch/reminders/RemindersView.tsx` (solo la lista);
  - `src/renderer/notch/code-review/ReviewsView.tsx`;
  - `src/renderer/notch/work-log/WorkLogView.tsx` y `src/renderer/notch/work-log/WorkLogDetail.tsx`;
  - `src/renderer/notch/redmine/RedmineView.tsx` (cabecera de la lista y consumo de `openTarget`);
  - `src/renderer/notch/redmine/RedmineIssueDetail.tsx` (el acceso directo, antes del botón de fijar, con `currentId={id}`).
- Test: `tests/e2e-tauri/redmine.spec.ts` (nuevo `it`)

**Interfaces:**
- Consumes: `shortcutShown` (Task 1); `openPinnedIssue`, `takeOpenTarget` y `useRedmine` (Task 2); `useSettings` e `integrationStyle` / `useIntegration('redmine')`.
- Produces: `export function PinnedIssueShortcut({ currentId, className }: { currentId?: number | null; className?: string }): ReactNode`. Devuelve `null` cuando `shortcutShown(...)` es `false`. Si se ve, pinta un `<button data-testid="redmine-pinned-shortcut">` con:
  - `aria-label` y `title` = `t('redmine.pin.open', { id: String(pinned.id), subject: pinned.subject })`;
  - el icono `Pin` en el color de Redmine (`style={integrationStyle(color)}` y `text-[color:var(--int)]`);
  - `onClick` = `openPinnedIssue`. En `Panel`, la clase es `panelIconButton`, para igualar el engranaje. En las demás cabeceras es `headerIconButton` + `className`.

- [ ] **Step 1: Write the failing e2e test**

En `tests/e2e-tauri/redmine.spec.ts`, añadir `it('pins an issue from its detail; the shortcut in the panel and other views opens it; pinning another replaces it; unpinning hides it')`, usando `connected`, `openRedmineView`, `fillValue`, `row`, `DETAIL`, `expectFullViewDetail`, `expectMode` y `clickCard`:
1. Abrir `#4012` (con `fillValue(SEARCH, '4012')` y Enter). `redmine-pin` tiene `aria-pressed="false"`; al pulsarlo pasa a `"true"`. En ese detalle no hay `redmine-pinned-shortcut` (`expectCount(…, 0)`).
2. Esc hasta el panel (`expectMode('expanded')`). `[data-notch-panel] [data-testid="redmine-pinned-shortcut"]` existe y su `aria-label` es «Abrir #4012 Revisar los permisos del informe mensual».
3. Con `clickCard` sobre la tarjeta de Notas, abrir la vista Notas. El acceso directo está en su cabecera; al pulsarlo se ve `expectMode('redmine')` y `DETAIL` con `data-issue-id="4012"`.
   - 3b. Esc a la lista de Redmine (la búsqueda vacía) y escribir `nada` en la búsqueda. El acceso directo de la cabecera de la lista abre `#4012` con la búsqueda vacía.
4. Volver, abrir `#412` y fijarla. En ese detalle, el acceso directo (que apunta a 4012) ya no está, porque ahora la fijada es 412, y `redmine-pin` está en `"true"`. Esc a la lista: el acceso directo dice «Abrir #412 …».
5. Abrir `#412` desde el acceso directo y pulsar `redmine-pin`: pasa a `"false"`. Esc: `redmine-pinned-shortcut` ya no existe en la lista ni en el panel.
6. Terminar con `expect(server.violations).toEqual([])` y `expectCleanLogs()`.

- [ ] **Step 2: Implement `PinnedIssueShortcut` and place it in every header listed above**

Va en último lugar. Si la cabecera no tiene nada empujado a la derecha, `className="ml-auto"`. Si ya hay un elemento con `ml-auto` (refrescar o añadir), el acceso directo va detrás de él, sin `ml-auto`.

- [ ] **Step 3: Consumo de `openTarget` en `RedmineView`**

Un efecto sobre `useRedmine((s) => s.openTarget)`. Cuando no es `null`:
- `const id = takeOpenTarget()`;
- si `id !== null`: `setQuery('')`, `setFresh(null)`, `pendingFocus.current = 'detail'` y `setPickedId(id)`.

Funciona al montarse y también con la vista ya abierta. `opened` será `undefined` y el detalle carga con el id.

- [ ] **Step 4: Typecheck, lint y vitest**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: todo en verde.

- [ ] **Step 5: Run the e2e (con el Developer Notch instalado cerrado)**

Run: `npx tauri build --debug --no-bundle --features e2e`, y después `npx wdio run tests/e2e-tauri/wdio.conf.mts --spec tests/e2e-tauri/redmine.spec.ts`
Expected: todas las pruebas de Redmine en verde, la nueva incluida.

---

### Task 5: DESIGN.md y verificación final

**Files:**
- Modify: `DESIGN.md`: un párrafo «**Tarea fijada de Redmine.**» junto a la descripción de la vista de Redmine. Debe decir:
  - el botón `Pin` / `PinOff` al final de la cabecera del detalle, en el color de la integración cuando está fijada;
  - que hay una sola tarea fijada, que no persiste y que se suelta sola al terminar la sesión, al cambiar de cuenta o ante un 404;
  - el acceso directo (solo el icono `Pin`, en el color de Redmine, el último de la cabecera, con «Abrir #id asunto»): en el panel (antes del engranaje), en Gmail (lista y lector), Notas y Recordatorios (listas), Revisiones, Registro de trabajo (lista y detalle) y Redmine (lista y detalle de otra tarea);
  - dónde no aparece: avisos de Claude, editor de notas, formulario de recordatorios y la cápsula.

- [ ] **Step 1: Escribir el párrafo en DESIGN.md**

- [ ] **Step 2: Verificación completa**

Run, en este orden: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run test:rust`.
Expected: todo en verde. Después de `test:rust` hay que recompilar el exe de la e2e antes de volver a lanzarla, porque `test:rust` lo sobrescribe.

- [ ] **Step 3: Pedir al usuario la aprobación del commit** (spec, plan, código, pruebas y DESIGN.md en un commit `feat(redmine): fijar una tarea como acceso directo`, o los que él prefiera)
