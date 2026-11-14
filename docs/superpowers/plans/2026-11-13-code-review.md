# GitHub y GitLab en el notch — Hito 1: PR/MR — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contadores por plataforma de PR/MR propios sin revisar en la cápsula, aviso cuando uno recibe su primera revisión, y vista "Revisiones" con lo que espera tu revisión y lo tuyo abierto, para github.com y un GitLab propio con tokens personales.

**Architecture:** Esquemas compartidos → clientes GitHub (GraphQL) y GitLab (REST v4) con zod → detector puro de primera revisión → integración por plataforma (ritmo 120 s en cualquier modo, espera creciente, `auth-error`, tokens cifrados con `safeStorage`) → IPC → cápsula, aviso, vista y página de Control Center. Patrón de Gmail.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Zustand, zod 4, Lucide, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-13-code-review-design.md`.

## Global Constraints

- Plataformas: `'github' | 'gitlab'`. GitHub = `https://api.github.com/graphql`; GitLab = origen configurado, **solo `https`**, API `/api/v4`. Tokens: GitHub `Authorization: Bearer`, GitLab `PRIVATE-TOKEN`.
- Listas: ≤ **20** por sección (`toReview`, `mine`). Contador = PR/MR **propios, abiertos, no borrador, sin ninguna revisión** (definición exacta del spec); `99+` desde 100.
- Aviso: PR/MR propio que pasa de sin revisar a revisado y sigue abierto; tipo `approved | changes | commented`; primera observación tras `reset()` no avisa; `reset()` al cambiar token o URL. Varios → un aviso con `count`.
- Ritmo: **120 000 ms** en cualquier modo; refresco manual mínimo 5 s; espera creciente 1 → 2 → 4 → 5 min; 401/403 → `auth-error` sin más consultas de esa plataforma hasta guardar otro token.
- Tokens cifrados con `safeStorage` en `userData/code-review-github.bin` y `code-review-gitlab.bin` (sin cifrado → solo memoria). Nunca al renderer ni al log.
- `SETTINGS_VERSION` 5 → **6** con `codeReview: { gitlabUrl: '', alerts: { github: { enabled: true, sound: true }, gitlab: { enabled: true, sound: true } } }`.
- Aviso en `alert`, prioridad igual que el correo (la más baja), **6 000 ms**, también en `mini`/`hidden`, sin robar foco; sonido con `playChime()` si está activado.
- Abrir solo URLs de la última lista cuyo origen sea `https://github.com` o el origen de GitLab configurado.
- Log y disco: nunca tokens, títulos, repositorios ni autores (solo recuentos, estados, códigos). i18n ES/EN; ≥ 24 px; tokens de `DESIGN.md`. Sin commits por tarea. No modificar `eslint.config.mjs`. Nunca usar tokens reales ni la red real en pruebas; nunca manejar el escritorio del usuario.

## Review Focus

1. **Token de GitLab apuntando a una URL ajena** (http, otro host tras redirección) → nunca se envía el token fuera del origen configurado; `fetch` sin seguir redirecciones a otro origen (Task 2).
2. **PR propio cerrado o fusionado sin revisión** → desaparece del contador sin aviso (Task 3).
3. **Token sin permiso para algunos repos u organización sin aprobar** (GitHub devuelve datos parciales o `errors` en GraphQL con 200) → se muestra lo disponible y se registra el código; no `auth-error` salvo 401/403 (Task 2, Task 4).
4. **GitLab antiguo sin estado de revisores ni `detailed_merge_status`** → solo aprobaciones cuentan y los campos faltantes no rompen la validación (Task 2).
5. **Cambiar el token con una consulta en curso** → el resultado viejo no pisa el estado nuevo ni dispara avisos (Task 4).

---

### Task 1: Esquemas, tipos y ajustes v6

**Files:** Create `src/shared/code-review/schema.ts`; Modify `src/shared/settings/schema.ts`, `src/main/services/settings-migrations.ts`; tests `tests/unit/shared/code-review-schema.test.ts`, `settings-schema.test.ts`, `tests/unit/main/settings-migrations.test.ts`.

**Interfaces — Produces:** `platformSchema`; `reviewStateSchema = 'none' | 'approved' | 'changes' | 'commented'`; `checksSchema = 'pass' | 'fail' | 'running' | null`; `itemSchema` / `ReviewItem` (spec, IPC); `platformStateSchema` / `PlatformState { status: 'unconfigured' | 'ok' | 'offline' | 'auth-error'; account: string | null; unreviewed: number | null; updatedAt: string | null; persistent: boolean }`; `codeReviewStateSchema { github, gitlab }`; `codeReviewAlertSchema { platform, count, kind?, ref?, title? }`; `gitlabUrlSchema` (solo `https`, sin credenciales, sin query/hash; se normaliza a origen + ruta base sin `/` final); entradas IPC (`listInput`, `openInput`, `setTokenInput { platform, token (1–255), url? }`, `clearInput`); `codeReviewSettingsSchema`, `DEFAULT_CODE_REVIEW_SETTINGS`, `SETTINGS_VERSION = 6`, migración 5 → 6.

- [ ] Tests: URL `http://` / con usuario / con query → rechazada; `https://gitlab.x.com/` → `https://gitlab.x.com`; estados y alertas estrictos; migración preserva todo lo anterior.
- [ ] RED → GREEN.

### Task 2: Clientes de GitHub y GitLab

**Files:** Create `src/main/code-review/github-client.ts`, `gitlab-client.ts`; tests `tests/unit/main/code-review-github-client.test.ts`, `code-review-gitlab-client.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** `createGithubClient({ fetch, token })` → `{ viewer(): Promise<string>; fetch(): Promise<{ toReview: ReviewItem[]; mine: ReviewItem[]; unreviewed: number; ownReview: { id: string; review: ReviewState }[] }> }`; `createGitlabClient({ fetch, baseUrl, token })` → mismo contrato (`viewer()` = username). Error `CodeReviewError { code: 'auth' | 'network' | 'rate-limited' | 'server' | 'invalid-response' }`.

- [ ] GitHub: una consulta GraphQL (spec) con variables; `review` desde `reviewDecision` + último review (APPROVED → approved, CHANGES_REQUESTED → changes, COMMENTED → commented, sin reviews → none); `checks` desde `statusCheckRollup.state`; `conflicts` desde `mergeable === 'CONFLICTING'`; `errors` en 200 con datos → usa los datos y no lanza (Review Focus 3); sin datos → `invalid-response`.
- [ ] GitLab: `/user`, dos listas, `/approvals` por MR propio; `review` desde aprobaciones y estado de revisores si existe; campos opcionales tolerados (Review Focus 4); `fetch` con `redirect: 'error'` (o comprobación de origen) para que el token nunca salga del origen (Review Focus 1).
- [ ] Tests con respuestas simuladas: mapeos de estado, 401/403 → `auth`, 429 → `rate-limited`, 5xx → `server`, red → `network`, esquema inválido → `invalid-response`, límite de 20, contador de sin revisar.
- [ ] RED → GREEN.

### Task 3: Detector de primera revisión

**Files:** Create `src/main/code-review/review-detector.ts`; test `tests/unit/main/code-review-detector.test.ts`.

**Interfaces — Produces:** `createReviewDetector()` → `{ observe(own: { id: string; review: ReviewState }[]): { id: string; kind: Exclude<ReviewState, 'none'> }[]; reset(): void }`.

- [ ] Tests: primera observación → `[]`; `none → approved|changes|commented` → aviso con su tipo; ya revisado que cambia de tipo → sin aviso; desaparece (cerrado/fusionado) → sin aviso (Review Focus 2); nuevo PR ya revisado → sin aviso; varios a la vez; `reset`.
- [ ] RED → GREEN.

### Task 4: Integración, tokens, IPC y cableado

**Files:** Create `src/main/code-review/code-review-integration.ts`, `code-review-ipc.ts`; reutilizar o generalizar `src/main/gmail/token-store.ts` para los dos archivos de token; Modify `src/shared/ipc/channels.ts`, `contract.ts`, `src/main/index.ts`; tests de integración, IPC, `register-ipc`, `ipc-contract`.

**Interfaces — Produces:** `createCodeReviewIntegration({ settings, tokenStores, clientFactories, timers, now, emit, openExternal, logger, onAlert })` → `{ ready; state(); list(platform); refresh(); open(platform, id); setToken(platform, token, url?); clear(platform); start(); dispose() }`; canales y eventos de la tabla IPC del spec.

- [ ] Tests (temporizadores falsos): sin token → `unconfigured`; con token → consulta y `ok`; tick 120 s; refresco mínimo 5 s; fallos → `offline` con espera creciente y datos conservados; 401/403 → `auth-error` sin más consultas; `setToken` valida con `viewer()` antes de guardar (`auth`/`network`/`url`); cambio de token/URL → reinicio del detector y generación nueva (Review Focus 5); aviso con avisos activados y no con desactivados; `open` solo con id de la última lista y origen permitido; `clear` borra token y estado; el log no contiene títulos ni tokens.
- [ ] Guards: lectura solo notch; `set-token`/`clear` solo Control Center; zod de entrada y salida.
- [ ] Cableado: `onAlert` → evento `code-review:alert` y aviso en el estado del notch (Task 5); `openExternal = shell.openExternal`; `fetch = net.fetch`; dev-switch `NOTCH_CODE_REVIEW_BASE_URLS` (ignorado empaquetado, solo `http://127.0.0.1:<puerto>`) para el E2E.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 5: Estado del notch, cápsula y aviso

**Files:** Modify `src/shared/notch/state.ts`, `geometry.ts` (`COMPACT_WIDTHS`, `CAPSULE_SIZES.reviews`), registry de integraciones, `IntegrationRow.tsx`, `CapsuleMetrics.tsx` (o el componente de la cápsula), `capsule-latch.ts`, `NotchApp.tsx`; Create `src/renderer/notch/code-review/ReviewAlert.tsx`, `src/renderer/shared/code-review-store.ts`; `messages.ts`; tests de estado, geometría, latch.

- [ ] `NotchState.reviewAlert` (prioridad = correo), evento `{ type: 'review', on }`, 6 s en el controlador, también en `mini`/`hidden`; modo/vista `reviews` en `PANEL_MODES`.
- [ ] Bloques por plataforma en la cápsula (icono `Github`/`Gitlab` + contador, latch); etiquetas accesibles del spec; anchos medidos ES/EN con el peor caso.
- [ ] Integración `reviews` en la fila (icono `GitPullRequest`); fila de 6 casillas medida; si no cabe, ajustar el ancho mínimo.
- [ ] `ReviewAlert` con los textos del spec; clic → vista en la plataforma, sección "Míos"; sonido si está activado.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 6: Vista "Revisiones"

**Files:** Create `src/renderer/notch/code-review/{ReviewsView,ReviewList}.tsx`, `src/renderer/shared/code-review/format.ts`; Modify `NotchApp.tsx`, `geometry.ts` (alto medido), `messages.ts`; test `tests/unit/renderer/code-review-format.test.ts`.

- [ ] Cabecera ← / "Revisiones" / pestañas (solo configuradas) / Actualizar; secciones "Por revisar" y "Míos"; filas con `ref`, título, autor (Por revisar), tiempo relativo y etiquetas (Borrador, Aprobado, Cambios pedidos, Sin revisar, Conflictos, Checks ✓/✗/en curso); acciones con hover o foco de teclado (`group-has-[:focus-visible]`).
- [ ] Estados: sin configurar, `auth-error`, sin conexión, vacío, cargando.
- [ ] Teclado: flechas, ←/→ pestañas, Enter abre, Esc vuelve.
- [ ] Tamaño medido con capturas (20 + 20 elementos con scroll; cabecera fija).
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 7: Control Center → GitHub y GitLab

**Files:** Create `src/renderer/control-center/CodeReviewPage.tsx`; Modify `ControlCenterApp.tsx` (página `code-review`, después de Gmail; abrible desde el notch), `messages.ts`, `controlCenterPageSchema`.

- [ ] Tarjeta por plataforma: token (`password` + mostrar), URL (GitLab), **Comprobar y guardar** (cuenta o error `auth`/`network`/`url`), **Quitar**, interruptores de avisos y sonido (parches serializados como `gmail-settings-patch.ts`); aviso si el token no se recordará (`persistent: false`); pasos breves y ruta de la guía.
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 8: E2E, guía y capturas

**Files:** Create `tests/e2e/code-review.spec.ts`, `tests/e2e/fixtures/fake-code-review.ts` (GraphQL de GitHub y REST de GitLab en `127.0.0.1`), `docs/code-review-setup.md`.

- [ ] Servidor falso: valida cabeceras de token; listas; aprobaciones; interruptor para pasar un PR a aprobado y para responder 401.
- [ ] Spec: guardar tokens en Control Center (cuenta mostrada); contadores en la cápsula; vista con pestañas y secciones; abrir (URL capturada); PR → aprobado → aviso (con el reloj de pruebas para no esperar 120 s); token inválido → "Revisa el token"; el log no contiene títulos ni tokens. Capturas `code-review-capsule-es.png`, `code-review-view-es.png`, `code-review-view-en.png`, `code-review-alert-es.png`, `code-review-settings.png`.
- [ ] Guía en español (spec, "Configuración por el usuario").
- [ ] `npm run build` y `npm run test:e2e` → PASS.

### Task 9: Verificación y documentación

- [ ] Revisión de la rama completa con subagente.
- [ ] DESIGN.md y PRD (GitHub/GitLab hito 1 hecho; hito 2 pendiente).
- [ ] Manual (usuario): con sus tokens reales.
