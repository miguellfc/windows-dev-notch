# 0.3.0 · Entrega 5 — Vistas simplificadas de GitHub, GitLab y Redmine: plan de implementación

> **Para agentes:** sub-skill obligatoria: superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`).

**Objetivo:** las vistas de GitHub y GitLab muestran solo las contribuciones y un acceso a la plataforma, y la de Redmine muestra el resumen y un buscador que lleva directamente al detalle de la tarea.

**Arquitectura:**
- **Revisiones en Rust.** Main deja de pedir la lista «Por revisar» y deja de enviar listas al renderer. Conserva internamente las PR/MR propias, porque de ellas salen las alertas y el recuento. Dos canales nuevos abren el perfil y la PR de la última alerta; las URL nunca salen de main.
- **Redmine.** La búsqueda es una función pura sobre las tareas asignadas ya cargadas. Un #número que no esté entre ellas se consulta con un canal nuevo que distingue «no existe o no tienes acceso» de un error real.
- **Geometría.** La vista de revisiones se reduce a lo que mide. Redmine tiene dos altos dentro de la misma ventana, igual que Gmail.

**Tecnología:** React 19, Tailwind 4, zod, Rust (Tauri 2), Vitest, `cargo test`, WebdriverIO con `tauri-driver`.

**Spec:** `docs/superpowers/specs/2026-11-17-v030-redesign-design.md`, secciones «Vistas» (GitHub y GitLab, Redmine) y la decisión «Clic en una alerta de revisión».

**Fuera de esta entrega:** la subida de versión a 0.3.0 y el `CHANGELOG`. El skill `.claude/skills/gitflow/SKILL.md` los hace en la rama `release/0.3.0`, cortada de `dev` cuando esta entrega esté fusionada.

## Restricciones globales

- **Rama:** `feat/v030-views` desde `dev`, en la carpeta principal del repo. **Sin worktrees.** PR hacia `dev`.
- **Commits:** locales autorizados; **nunca push** sin pedirlo. Cada commit lleva el trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Límites:**
  - No editar `eslint.config.mjs` ni los hooks.
  - No cerrar procesos que no lancen las pruebas.
  - Las e2e necesitan cerradas la Developer Notch instalada y las ventanas que puedan tomar el foco (WebStorm, Windows Terminal y similares); hay que pedírselo al usuario.
- **Vista GitHub/GitLab:**
  - Se mantienen la rejilla, la tabla Hoy · Semana · Mes × Commits · PR/MR abiertos · PR/MR fusionados · Revisiones, sus textos y sus estados.
  - Debajo, una fila con la cuenta o el servidor en mono y el botón `Abrir GitHub` / `Abrir GitLab` con el icono `ExternalLink`.
  - **Se eliminan** «Por revisar» y «Míos».
- **Alerta de revisión:** con una sola PR/MR, el clic la abre en el navegador; con varias, o sin dato, abre la vista de contribuciones de esa plataforma.
- **Vista Redmine:**
  - En reposo, solo el resumen y el buscador.
  - **Se elimina** la lista «Tareas asignadas».
  - Una coincidencia lleva directamente a su detalle, bajo el buscador.
  - Varias coincidencias muestran una lista de 5 filas como máximo.
  - Sin coincidencias, se muestra `redmine.view.noMatch`.
  - Mientras se busca, el resumen se comprime en una línea: «Hoy 5,5H · Semana 21H · Mes 38,5H».
- **Seguridad:** el renderer nunca recibe ni envía URL. Main solo abre `https://github.com` o el origen del GitLab configurado.
- **ES/EN:** todo texto nuevo va en los dos idiomas.

## Decisiones tomadas en este plan

- **La versión 0.3.0 no se sube aquí.** La spec la colocaba en esta entrega, pero el flujo del repo la hace en `release/0.3.0`.
- **Los canales `code-review:list` y `code-review:open` se eliminan,** porque su único consumidor es la vista que pierde las listas.
- **Dos altos en Redmine,** como Gmail: `REDMINE_SIZES = { rest, search }`. La ventana se dimensiona siempre para `search` (520×560), y la cápsula es más baja en reposo.
- **La vista de revisiones deja de medir igual que Redmine:** pasar de una a otra redimensiona la ventana.
- **Búsqueda automática,** sin pulsar Enter. La consulta de un #número ajeno espera 300 ms desde la última tecla.
- **Un #número sin acceso (403) o inexistente (404)** se muestra como `redmine.view.noMatch` y no cierra la sesión de Redmine. Hoy un 403 pondría toda la sesión en `auth-error`.

## Foco de revisión

1. **#número de un proyecto sin acceso o inexistente:** se ve «sin coincidencias» y la sesión de Redmine sigue conectada. Lo cubre Rust (Task 3).
2. **Escribir deprisa:** una respuesta tardía de un #número anterior nunca sustituye al resultado de lo último escrito. Lo cubre `searchStep` (Task 4).
3. **Clic en una alerta caducada o con URL de otro origen:** no se abre nada indebido y se cae a la vista de contribuciones. Lo cubre Rust (Task 1).
4. **Búsqueda con mayúsculas, acentos, `#` y espacios:** encuentra lo mismo que hoy. Lo cubre `redmineSearch` (Task 4).
5. **Plataforma sin cuenta conocida o sin configurar:** no aparece el botón de abrir perfil. Lo cubre `profileRow` (Task 2).

---

### Task 1: Backend de revisiones sin listas

**Archivos:**
- Modificar: `src-tauri/src/code_review/github.rs` (sin `$toReview` ni su alias; el fragmento `pr` pierde `checks`, `mergeable` y `author`), `gitlab.rs` (sin la consulta `reviewer_id`), `client.rs` (`CodeReviewSnapshot` sin `to_review`), `integration.rs`, `ipc.rs`
- Modificar: `src-tauri/src/contract/code_review.rs`, `src-tauri/src/contract/mod.rs`, `src-tauri/src/ipc/guard.rs`
- Modificar: `src/shared/code-review/schema.ts`, `src/shared/ipc/contract.ts`, `src/shared/ipc/channels.ts`
- Modificar: `tests/parity/channels.json`, `tests/parity/contract-cases.json`, `tests/unit/shared/parity.test.ts` (`portedChannels`), `tests/e2e-tauri/fixtures/fake-code-review.ts`
- Tests: `src-tauri/src/code_review/{integration,ipc,github,gitlab}_tests.rs`, `tests/unit/shared/code-review-schema.test.ts`, `tests/unit/shared/ipc-contract.test.ts`

**Interfaces (produce):**
- Canal `code-review:open-profile`, entrada `{ platform }`, salida `{ opened: boolean }`. Abre `https://github.com/<cuenta>` o `<gitlabUrl>/<cuenta>`. Sin cuenta conocida devuelve `opened: false`.
- Canal `code-review:open-alert`, entrada `{ platform }`, salida `{ opened: boolean }`. Abre la URL de la última alerta de **una sola** PR/MR de esa plataforma, si sigue guardada y su origen es válido; si no, devuelve `opened: false`.
- Main guarda `last_alert_url: Option<String>` por plataforma. Se fija al emitir una alerta con `count == 1`, se borra con `count > 1` y al desactivar la plataforma o cambiar de sesión.
- Se eliminan `code-review:list`, `code-review:open`, `CodeReviewList`, `itemSchema` y `rt.sent`.
- `CodeReviewAlert` no cambia.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `poll_does_not_request_the_to_review_list` (GitHub y GitLab): la consulta no incluye `review-requested` ni `reviewer_id`.
  - `unreviewed_count_survives_more_than_twenty_own_prs` (GitHub): el recuento sigue saliendo de la búsqueda `review:none`.
  - `single_alert_keeps_its_url_and_open_alert_opens_it`.
  - `many_alerts_clear_the_url_and_open_alert_returns_false`.
  - `open_alert_refuses_another_origin`.
  - `open_profile_builds_the_platform_url` (GitHub y GitLab con su servidor) y `open_profile_without_account_returns_false`.
  - `disabling_a_platform_forgets_its_alert_url`.
- [ ] **Paso 2:** `cargo test --manifest-path src-tauri/Cargo.toml code_review::` → FAIL.
- [ ] **Paso 3: implementar** y actualizar contratos, guardas y casos de paridad. Hasta la Task 2, `ReviewsView` deja de pedir la lista y muestra solo las contribuciones.
- [ ] **Paso 4:** `npm run test:rust` (con fmt y clippy), `npx vitest run`, `npm run typecheck` y `npm run lint` → PASS.
- [ ] **Paso 5: commit** `feat(code-review): sin listas y con apertura de perfil y alerta desde main`.

### Task 2: Vista de contribuciones y alerta

**Archivos:**
- Modificar: `src/renderer/notch/code-review/ReviewsView.tsx`, `ReviewAlert.tsx`, `src/renderer/notch/NotchApp.tsx` (carga de la alerta), `src/renderer/shared/code-review-store.ts` (`ReviewsTarget` sin `section`), `src/renderer/shared/code-review/format.ts`
- Borrar: `src/renderer/notch/code-review/ReviewList.tsx`
- Modificar: `src/shared/notch/geometry.ts` y `src-tauri/src/notch/geometry.rs` (`REVIEWS_SIZE`); regenerar `tests/parity/geometry.json`
- Modificar: `src/shared/i18n/messages.ts`
- Tests: `tests/unit/renderer/code-review-format.test.ts`, `tests/unit/shared/notch-geometry.test.ts`

**Interfaces:**
- **Consume:** `code-review:open-profile` y `code-review:open-alert` (Task 1).
- **Produce:**
  - `profileRow(state: PlatformState, gitlabUrl: string): { label: string } | null`, en `format.ts`. `label` es la cuenta (o `servidor · cuenta` en GitLab); `null` sin cuenta.
  - `REVIEWS_SIZE`: 520 × el alto medido del peor caso.
- **Comportamiento de la alerta:** con `count === 1` llama a `open-alert`. Si devuelve `opened: true`, se descarta la alerta; si no, abre la vista de esa plataforma. Con `count > 1` abre la vista directamente.
- **i18n:** `codeReview.view.openProfile`: «Abrir {platform}» / «Open {platform}».

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `profileRow`: con cuenta en GitHub da la cuenta; en GitLab incluye el servidor sin `https://`; sin cuenta o `unconfigured` da `null`.
  - Geometría: `CAPSULE_SIZES.reviews` tiene el alto medido, y `redmine` pasa a ser el panel más alto. Se reescribe la prueba «tallest panel».
- [ ] **Paso 2:** `npx vitest run tests/unit/renderer/code-review-format.test.ts tests/unit/shared/notch-geometry.test.ts` → FAIL.
- [ ] **Paso 3: implementar.** Medir el alto en WebView2 con el peor caso (6 semanas, avisos de datos parciales y privados, error de contribuciones) con una e2e temporal, fijar `REVIEWS_SIZE` y borrar esa e2e.
- [ ] **Paso 4:** `npm run test:rust`, `npx vitest run`, `npm run typecheck`, `npm run lint` y `npm run build:tauri-renderer` → PASS.
- [ ] **Paso 5: commit** `feat(reviews): vista solo de contribuciones con acceso a la plataforma`.

### Task 3: Canal para buscar una tarea por número

**Archivos:**
- Modificar: `src-tauri/src/redmine/integration.rs`, `src-tauri/src/redmine/ipc.rs`, `src-tauri/src/redmine/client.rs` (si hace falta distinguir 403 y 404), `src-tauri/src/contract/` (Redmine), `src-tauri/src/ipc/guard.rs`
- Modificar: `src/shared/redmine/schema.ts`, `src/shared/ipc/contract.ts`, `src/shared/ipc/channels.ts`, `tests/parity/channels.json`, `tests/parity/contract-cases.json`, `tests/unit/shared/parity.test.ts`
- Tests: `src-tauri/src/redmine/integration_tests.rs`, `src-tauri/src/redmine/client_tests.rs`, `tests/unit/shared/ipc-contract.test.ts`

**Interfaces (produce):**
- Canal `redmine:find-issue`, entrada `{ id: number }`, salida `{ found: boolean }`.
  - 200 da `found: true` y registra el id en `read_issues`.
  - 403 y 404 dan `found: false` **sin cambiar el estado de la sesión**.
  - 401 sigue el camino de hoy (`auth-error`).
  - Un fallo de red devuelve el error `UNAVAILABLE` de siempre.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `find_issue_found_marks_it_readable`.
  - `find_issue_forbidden_is_not_found_and_keeps_the_session`.
  - `find_issue_missing_is_not_found`.
  - `find_issue_unauthorized_ends_the_session`.
- [ ] **Paso 2:** `cargo test --manifest-path src-tauri/Cargo.toml redmine::` → FAIL.
- [ ] **Paso 3: implementar.**
- [ ] **Paso 4:** `npm run test:rust` (con fmt y clippy), `npx vitest run`, `npm run typecheck` y `npm run lint` → PASS.
- [ ] **Paso 5: commit** `feat(redmine): buscar una tarea por número sin afectar a la sesión`.

### Task 4: Vista de Redmine con buscador

**Archivos:**
- Modificar: `src/renderer/notch/redmine/RedmineView.tsx`, `RedmineSummary.tsx` (variante compacta en una línea), `RedmineIssueList.tsx` (como máximo 5 filas, sin el aviso de 300)
- Crear: `src/renderer/shared/redmine/search.ts`
- Modificar: `src/shared/notch/geometry.ts` y `src-tauri/src/notch/geometry.rs` (`REDMINE_SIZES`); regenerar `tests/parity/geometry.json`
- Modificar: `src/shared/i18n/messages.ts`
- Tests: `tests/unit/renderer/redmine-search.test.ts` (nuevo), `tests/unit/shared/notch-geometry.test.ts`

**Interfaces:**
- **Consume:** `redmine:find-issue` (Task 3), `matchesIssue` y `RedmineIssueDetail` tal como están.
- **Produce** en `search.ts` (funciones puras):
  - `redmineSearch(query: string, issues: Issue[]): SearchResult`, donde `SearchResult` es:
    - `{ kind: 'idle' }` con la consulta vacía o solo espacios;
    - `{ kind: 'one'; id: number }` con una coincidencia;
    - `{ kind: 'many'; issues: Issue[]; more: number }` con varias (5 como máximo en `issues`; `more` es el resto);
    - `{ kind: 'lookup'; id: number }` con un #número que no está en la lista;
    - `{ kind: 'none' }` sin coincidencias.
  - `searchStep(current: LookupState, event: LookupEvent): LookupState`, que descarta las respuestas cuyo id no sea el de la última consulta.
- **Tamaños:** `REDMINE_SIZES = { rest: { width: 520, height: <medido> }, search: { width: 520, height: 560 } }`. `CAPSULE_SIZES.redmine` es `search`, y la ventana no cambia al buscar.
- **Teclado:** Esc vacía el buscador; con el buscador vacío, vuelve al panel. ↓ desde el buscador baja a la lista de varias coincidencias, y Enter abre la fila. Elegir una fila abre su detalle; Esc vuelve a la lista.
- **Foco:** al aparecer un detalle por lo que se escribe, el foco se queda en el buscador.
- **i18n:** `redmine.search.more`: «{count} más · afina la búsqueda» / «{count} more · refine your search».

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `redmineSearch`:
    - cadena vacía o solo espacios da `idle`;
    - `#412` y `412` con esa tarea en la lista dan `one`;
    - `#9999` fuera de la lista da `lookup`;
    - `DISEÑO` y `diseno` encuentran lo mismo;
    - 7 coincidencias dan `many` con 5 filas y `more: 2`;
    - texto sin coincidencias da `none`.
  - `searchStep`: la respuesta del id 41 llega después de consultar el 412 y se ignora; la del 412 se aplica.
- [ ] **Paso 2:** `npx vitest run tests/unit/renderer/redmine-search.test.ts` → FAIL.
- [ ] **Paso 3: implementar.** Medir el alto de reposo en WebView2 con una e2e temporal, fijar `REDMINE_SIZES.rest` y borrar esa e2e.
- [ ] **Paso 4:** `npm run test:rust`, `npx vitest run`, `npm run typecheck`, `npm run lint` y `npm run build:tauri-renderer` → PASS.
- [ ] **Paso 5: commit** `feat(redmine): resumen y buscador que lleva al detalle`.

### Task 5: E2E, documentación y verificación

**Archivos:**
- Modificar: `tests/e2e-tauri/code-review.spec.ts` (se retiran las pruebas de filas y secciones; se añaden abrir perfil y clic en alerta)
- Modificar: `tests/e2e-tauri/redmine.spec.ts` (el detalle se alcanza con el buscador)
- Modificar: `DESIGN.md` (vistas de revisiones y Redmine, alerta de revisión y tamaños) y `PRODUCT.md` si menciona las listas

- [ ] **Paso 1: actualizar las e2e**, en ES:
  - `code-review.spec.ts`:
    - `the view shows contributions and no review lists`;
    - `open profile opens the platform in the browser` (con `openedUrls()`, GitHub y GitLab);
    - `a single review alert opens the pull request`;
    - `several review alerts open the contributions view`.
  - `redmine.spec.ts`:
    - `at rest there is only the summary and the search box`;
    - `a number in the list opens its detail`;
    - `a number outside the list opens its detail`;
    - `a forbidden number shows no match and keeps the session`;
    - `several matches show a short list`;
    - `the summary compresses while searching`.
  - Las pruebas de estado, estimación e imputación se conservan, llegando al detalle por el buscador.
- [ ] **Paso 2: e2e completa.** Con la notch instalada y las ventanas que puedan tomar el foco cerradas, `npm run test:e2e` → PASS. Si algo falla, leer `test-results/e2e-focus-failures.log` antes de juzgarlo.
- [ ] **Paso 3: capturas** en ES de GitHub, GitLab, Redmine en reposo, con una coincidencia y con varias. Dejarlas en la carpeta de notas compartida para el usuario.
- [ ] **Paso 4: verificación final.** `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build:tauri-renderer` y `npm run test:rust`.
- [ ] **Paso 5: commit** `docs(design): vistas simplificadas de GitHub, GitLab y Redmine`.
