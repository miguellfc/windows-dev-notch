# Panel: baldosas GitHub y GitLab, iconos en la cabecera y sin pie — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dividir la baldosa Revisiones en GitHub y GitLab (vista sin pestañas), pasar Control Center (`Cog`) y Ocultar a botones de icono en la cabecera, quitar el pie y ensanchar el panel a 480 px.

**Architecture:** Las baldosas GitHub/GitLab fijan el objetivo de la vista de revisiones con `setReviewsTarget` y abren la integración `reviews` existente (sin IPC nuevo). `ReviewsView` deja de tener pestañas y toma la plataforma del objetivo. `Panel` en `NotchApp.tsx` pierde el `nav` y el `footer` y gana dos botones de icono; `geometry.ts` cambia el ancho y las alturas medidas.

**Tech Stack:** Electron 45, React 19, TypeScript, Tailwind v4, lucide-react, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-14-panel-header-tiles-design.md`

## Global Constraints

- Orden de baldosas: Terminal, Recordatorios, Sistema, Notas, Gmail, GitHub, GitLab, Claude.
- `CAPSULE_SIZES.expanded.width` = 480. `EXPANDED_HEIGHTS` = valores medidos con Playwright en la app (sin hueco ni recorte).
- Icono de Control Center: Lucide `Cog`; Ocultar: `EyeOff`. Botones de 28 px, icono de 16 px en Grafito, hover/foco Tiza sobre Velo, radio `--radius-control-sm`, `aria-label` y `title` = textos de `notch.panel.controlCenter` / `notch.panel.hide`.
- Claves i18n `integration.github` = "GitHub", `integration.gitlab` = "GitLab" (ES y EN); `data-testid` `integration-github` / `integration-gitlab`.
- Sin dependencias nuevas; no se toca `eslint.config.mjs`. Nada se commitea sin aprobación del usuario (los cambios quedan sin commitear). No cambiar de rama.
- `npm run typecheck` tiene 10 errores preexistentes en `tests/e2e/*.spec.ts` (`SVGElement | HTMLElement`); cualquier otro error es nuevo.

## Review Focus

- Abrir la vista de una plataforma **no configurada** desde su baldosa: debe mostrar su "sin configurar", nunca la otra plataforma → prueba e2e en Task 1.
- Abrir la vista **sin objetivo** (aviso sin plataforma, recarga del renderer): primera plataforma configurada o `github`, sin error → prueba unitaria de la función de selección en Task 1.
- Volver de la vista al panel y abrir la otra baldosa: la vista cambia de plataforma (el objetivo no se queda pegado) → e2e en Task 1.
- Los botones de icono se alcanzan con Tab y se activan con Enter/Espacio (son `<button>`) → e2e en Task 2.
- Las 8 baldosas caben sin cortar nombres en ES y EN a 480 px → e2e en Task 2.

---

### Task 1: Baldosas GitHub/GitLab y vista de revisiones sin pestañas

**Files:**
- Modify: `src/shared/integrations/registry.ts` (sustituir la baldosa `reviews` por GitHub y GitLab)
- Modify: `src/shared/i18n/messages.ts` (añadir `integration.github`/`integration.gitlab`; quitar `integration.reviews` si queda sin uso)
- Modify: `src/renderer/notch/IntegrationRow.tsx` (iconos `GithubMark`/`GitlabMark` de `../shared/brand-icons`; el clic fija el objetivo y abre `reviews`)
- Modify: `src/renderer/notch/code-review/ReviewsView.tsx` (sin pestañas; cabecera con el nombre de la plataforma)
- Modify: `src/shared/code-review/format.ts` o el módulo puro que convenga (función de selección de plataforma)
- Test: `tests/unit/shared/integrations-registry.test.ts`, test unitario de la selección (p. ej. en `tests/unit/renderer/code-review-format.test.ts`), `tests/e2e/code-review.spec.ts`
- Modify: `DESIGN.md` (secciones del panel "Revisiones" y de la casilla: sin pestañas, cabecera con nombre de plataforma, baldosas GitHub/GitLab)

**Interfaces:**
- Produces: un tipo de baldosa que abre la vista `reviews` con plataforma, p. ej. `{ kind: 'review'; id: Platform; labelKey: MessageKey }` en la unión `Tile` (el implementador puede elegir otra forma equivalente). `tiles` tiene 8 entradas en el orden de Global Constraints.
- Produces: `reviewsPlatform(target: Platform | null, configured: readonly Platform[]): Platform` = `target ?? configured[0] ?? 'github'` (sin saltar a otra plataforma si `target` no está configurada).

- [ ] **Step 1: Tests que fallan.**
  - Registro: `tiles.map(t => t.id)` = `['terminal','reminders','system','notes','gmail','github','gitlab','claude']`; las baldosas `github`/`gitlab` son del tipo de revisión.
  - `reviewsPlatform`: `('gitlab', ['github'])` → `'gitlab'`; `(null, ['gitlab'])` → `'gitlab'`; `(null, [])` → `'github'`.
  - e2e (`code-review.spec.ts`): sustituir `integration-reviews` y los `getByRole('tab', …)` por abrir `integration-github` / `integration-gitlab` (volviendo al panel con Esc entre medias); comprobar que no hay `role="tab"`/`tablist`, que la cabecera dice "GitHub"/"GitLab", y que con solo GitHub configurado la baldosa GitLab muestra el estado "sin configurar" de GitLab.
- [ ] **Step 2:** `npx vitest run tests/unit/shared/integrations-registry.test.ts <test de selección>` → FAIL.
- [ ] **Step 3: Implementar.** Registro + i18n; `IntegrationRow` (icono por id, clic `setReviewsTarget({ platform, section: <la sección por defecto que usa hoy la vista> })` + `openIntegration({ id: 'reviews' })`); `ReviewsView` sin `tablist`/`tab`/`tabpanel`, sin ←/→ de pestañas (las flechas entre filas y el teclado del gráfico siguen), plataforma = `reviewsPlatform(target?.platform ?? null, configured)`, cabecera y `aria-label` con `PLATFORM_NAMES[platform]`. Revisar `ReviewsTarget` por si `section` debe ser opcional.
- [ ] **Step 4:** `npx vitest run` de esos tests → PASS; `npm run typecheck && npm run lint && npm test`.
- [ ] **Step 5:** `npx playwright test tests/e2e/code-review.spec.ts` tras `npm run build` → PASS. Dejar sin commitear.

### Task 2: Cabecera con botones de icono, sin pie, panel de 480 px

**Files:**
- Modify: `src/renderer/notch/NotchApp.tsx` (`Panel`: cabecera con `Cog`/`EyeOff`, sin `nav` ni `footer`; quitar `shortcut` de `Panel` si queda sin uso)
- Modify: `src/shared/i18n/messages.ts` (quitar `notch.panel.escHint` si queda sin uso)
- Modify: `src/shared/notch/geometry.ts` (`expanded.width` 480; `EXPANDED_HEIGHTS` medidas)
- Modify: `src/renderer/notch/IntegrationRow.tsx` (solo el comentario de anchos: 8 baldosas, fila de 454 px, etiquetas medidas en ES/EN)
- Test: `tests/unit/shared/notch-geometry.test.ts`, `tests/e2e/app.spec.ts` (y cualquier e2e que use el pie o los botones con texto)
- Modify: `DESIGN.md` (panel de 480 px, cabecera, sin pie, icono `Cog`, alturas)

**Interfaces:**
- Consumes: `tiles` de 8 entradas (Task 1).

- [ ] **Step 1: Medir alturas.** Con un script Playwright temporal fuera del repo (o el scratchpad), tras implementar la cabecera, medir la altura natural del contenido del panel con 0, 1 y ≥2 sesiones (como se midieron las actuales 236/284/308: sin hueco ni recorte). Anotar los valores.
- [ ] **Step 2: Tests.** `notch-geometry.test.ts`: `CAPSULE_SIZES.expanded` = `{ width: 480, height: EXPANDED_HEIGHTS.sessions }` y `EXPANDED_HEIGHTS` = los valores medidos. `app.spec.ts`: "the eight integration tiles fit the panel without cutting a label, in ES and EN"; nueva prueba: los botones `Control Center` y `Ocultar` (por `aria-label`) están en la cabecera, se alcanzan con Tab, Control Center abre su ventana y Ocultar oculta el notch; el texto "Esc para cerrar" no está en el panel.
- [ ] **Step 3: Implementar** `Panel` (cabecera: hora izquierda; derecha fecha + botones de 28 px), quitar `nav`/`footer`, geometría y comentario.
- [ ] **Step 4:** `npm run typecheck && npm run lint && npm test` → verde (salvo los 10 preexistentes).
- [ ] **Step 5:** `npm run build && npx playwright test tests/e2e/app.spec.ts` → PASS. DESIGN.md actualizado. Dejar sin commitear.

### Task 3: Verificación completa y revisión visual

- [ ] **Step 1:** `npm run test:e2e` → todo pasa (un fallo de arranque intermitente se repite una vez y se anota).
- [ ] **Step 2:** Capturas Playwright solo de ventanas de la app, en el scratchpad: panel expandido en ES y EN (0 y ≥2 sesiones), vista GitHub y vista GitLab, hover/foco de los botones de la cabecera. Medir el ancho de la fila (≤ 454 px) y confirmar que no hay hueco bajo el contenido.
- [ ] **Step 3:** `git status --short` sin archivos temporales; resumen al usuario para aprobar el commit.
