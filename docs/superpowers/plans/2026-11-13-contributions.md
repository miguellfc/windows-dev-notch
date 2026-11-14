# GitHub y GitLab en el notch — Hito 2: contribuciones — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En la vista "Revisiones", por pestaña, un gráfico de contribuciones del mes en curso y un resumen de hoy, semana y mes, encima de las listas de PR/MR.

**Architecture:** Módulo puro de fechas, rejilla, niveles y clasificación de eventos → métodos `contributions()` en los clientes de GitHub (GraphQL) y GitLab (eventos REST paginados) → integración con caché y temporizador de 15 min solo con la vista abierta → IPC `code-review:contributions` → componentes `ContributionGraph` y `ContributionSummary` en la vista.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Zustand, zod 4, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-13-contributions-design.md` (se apoya en `2026-11-13-code-review-design.md`).

## Global Constraints

- Fechas en zona **local**; semana **lunes → domingo**; mes natural en curso; "hoy" desde las 00:00 locales.
- Rejilla: 7 filas (lun→dom) × 5–6 columnas; días fuera del mes `inMonth: false`; días posteriores a hoy `future: true`.
- Niveles 0–4: 0 = sin actividad; 1–4 por cuartiles del máximo del mes (`ceil(count / max * 4)`), todo a 0 si `max === 0`.
- GitHub: `contributionsCollection` (mes, semana y hoy con alias) + búsquedas `is:pr author:@me is:merged merged:>=YYYY-MM-DD` (`first: 0`, `issueCount`) para hoy, semana y mes; `restricted` = `restrictedContributionsCount > 0`.
- GitLab: `GET /api/v4/users/:id/events?after=<día anterior al 1>&before=<mañana>&per_page=100&page=N` en serie, máximo **10 páginas** (`partial: true` si se alcanza); gráfico = 1 por evento; resumen: commits = suma de `push_data.commit_count` (pushed), abiertos = `opened`+MergeRequest, fusionados = `accepted`/`merged`+MergeRequest, revisiones = `approved`+MergeRequest y comentarios con `note.noteable_type === 'MergeRequest'`.
- Ritmo: al abrir la vista, cada **900 000 ms** con la vista abierta, y con Actualizar (mínimo 5 s); nunca con la vista cerrada. 401/403 → `auth-error` del hito 1; otros fallos → conservar datos + error con Reintentar.
- Mismos tokens, orígenes y reglas del hito 1 (sin redirecciones, nada en el log salvo recuentos y códigos, nada en disco).
- i18n ES/EN con `Intl`; tokens de `DESIGN.md`; ≥ 24 px en los controles. Sin commits por tarea. No modificar `eslint.config.mjs`. Nunca tokens reales ni la red real en pruebas; nunca el escritorio del usuario.

## Review Focus

1. **Cambio de horario de verano/invierno dentro del mes** → ningún día duplicado ni perdido en la rejilla ni en los rangos (Task 1).
2. **Evento de GitLab a las 23:30 UTC** → cae en el día local correcto (Task 1, Task 2).
3. **GitHub con token fine-grained sin acceso a algunos repos** → recuentos parciales sin error y `restricted` cuando aplique (Task 2).
4. **Vista abierta al pasar la medianoche o el fin de mes** → la siguiente consulta usa el rango nuevo (Task 3).
5. **Error solo en contribuciones** → las listas de PR/MR siguen intactas (Task 3, Task 4).

---

### Task 1: Módulo puro de contribuciones

**Files:** Create `src/shared/code-review/contributions.ts`; Modify `src/shared/code-review/schema.ts` (esquemas `contributionDaySchema`, `contributionTotalsSchema`, `contributionSummarySchema`, entrada `{ platform }`); test `tests/unit/shared/code-review-contributions.test.ts`.

**Interfaces — Produces:** `monthRange(now: Date): { from: Date; to: Date; month: string }`; `weekStart(now: Date): Date`; `dayStart(now: Date): Date`; `localDate(d: Date): string` (`YYYY-MM-DD` local); `buildGrid(month: string, counts: ReadonlyMap<string, number>, today: string): ContributionDay[][]`; `levelFor(count, max): 0|1|2|3|4`; `classifyGitlabEvent(e): { contribution: boolean; commits: number; opened: boolean; merged: boolean; review: boolean }`; `sumTotals(...)`.

- [ ] Tests: meses de 28/29/30/31 días; mes que empieza en lunes y en domingo; cambio de horario (Review Focus 1); evento 23:30 UTC → día local (Review Focus 2, con `TZ` fijada en el test o fechas construidas en local); rejilla con 5 y 6 columnas; niveles (todo 0, un solo día, máximos repetidos); clasificación de cada tipo de evento de GitLab y de un comentario en issue (no revisión); esquemas estrictos.
- [ ] RED → GREEN.

### Task 2: Clientes

**Files:** Modify `src/main/code-review/github-client.ts`, `gitlab-client.ts`, `client-common.ts`; tests `tests/unit/main/code-review-github-client.test.ts`, `code-review-gitlab-client.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** `contributions(now: Date): Promise<ContributionSummary>` en ambos clientes.

- [ ] GitHub: una consulta GraphQL con `viewer.contributionsCollection` (alias `month`, `week`, `today`) y tres búsquedas de fusionados; mapeo a `ContributionSummary`; `restricted`; datos parciales con `errors` en 200 → usa los datos (Review Focus 3).
- [ ] GitLab: páginas en serie con `X-Next-Page` o hasta una página con < 100; límite 10 → `partial`; clasificación de Task 1; mismas reglas de origen/redirección del hito 1.
- [ ] Tests con respuestas simuladas: mapeo, totales, fusionados, `restricted`, paginación, límite, 401/403/429/5xx.
- [ ] RED → GREEN.

### Task 3: Integración e IPC

**Files:** Modify `src/main/code-review/code-review-integration.ts`, `code-review-ipc.ts`, `src/shared/ipc/channels.ts`, `contract.ts`; tests de integración, IPC, `register-ipc`, `ipc-contract`.

**Interfaces — Produces:** `integration.contributions(platform): Promise<ContributionSummary | null>`; `integration.setViewOpen(open: boolean)` (o el aviso de abrir/cerrar que ya exista en la vista); canal `code-review:contributions { platform }` (solo notch).

- [ ] Caché por plataforma; consulta al abrir la vista y cada 900 000 ms solo con la vista abierta; refresco manual comparte el mínimo de 5 s; cambio de token → generación nueva y caché vacía; cambio de día/mes → el siguiente rango (Review Focus 4); un fallo en contribuciones no toca el estado ni las listas (Review Focus 5); 401/403 → `auth-error` como el hito 1.
- [ ] Tests con temporizadores falsos y reloj controlado; el log no contiene nombres de repositorios.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 4: Gráfico, resumen y vista

**Files:** Create `src/renderer/notch/code-review/{ContributionGraph,ContributionSummary}.tsx`; Modify `ReviewsView.tsx`, `src/renderer/shared/code-review-store.ts`, `src/shared/notch/geometry.ts` (`REVIEWS_SIZE` medido), `messages.ts`; tests de geometría y del formato.

- [ ] Gráfico según el spec (cuadrados ~14 px, 3 px de separación, niveles en azul hielo, hoy con borde, futuros vacíos, etiquetas de días y mes, hover/foco con fecha y recuento); tabla accesible con navegación por flechas y resumen textual.
- [ ] Resumen Hoy · Semana · Mes × Commits · PR/MR abiertos · PR/MR fusionados · Revisiones; "N contribuciones en <mes>"; "Actualizado hace N min"; líneas de `partial`/`restricted`.
- [ ] Estados: cargando (estático con `prefers-reduced-motion`), error con Reintentar, sin configurar / revisa el token.
- [ ] Listas de PR/MR debajo con su propio desplazamiento; tamaño del panel medido con capturas (ES/EN, mes de 6 columnas) y orden de redimensionado coherente si pasa a ser el más alto.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 5: E2E, documentación y capturas

**Files:** Modify `tests/e2e/fixtures/fake-code-review.ts`, `tests/e2e/code-review.spec.ts`, `docs/code-review-setup.md` (sección breve sobre las contribuciones y la limitación de los tokens detallados).

- [ ] Servidor falso: `contributionsCollection` con calendario y totales; búsquedas de fusionados; eventos de GitLab en 2 páginas; interruptor de error solo en contribuciones.
- [ ] Spec: gráfico con los días del mes y niveles esperados; resumen con las cifras esperadas por pestaña; error en contribuciones → Reintentar y las listas siguen; sin consultas de contribuciones con la vista cerrada. Capturas `contributions-github-es.png`, `contributions-gitlab-en.png`.
- [ ] `npm run build` y `npm run test:e2e` → PASS.

### Task 6: Verificación y documentación

- [ ] Revisión de la rama completa con subagente.
- [ ] DESIGN.md (gráfico y resumen en la vista Revisiones) y PRD (hito 2 hecho).
- [ ] Manual (usuario): con sus tokens reales.
