# Tauri, parte 4: GitHub y GitLab — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la versión Tauri tenga las revisiones de código de la 0.1.0 para GitHub y GitLab (instancia propia): PR/MR pendientes de tu revisión y propios abiertos, recuentos en la cápsula, aviso de primera revisión, contribuciones del mes y tokens cifrados.

**Architecture:** módulo `src-tauri/src/code_review/` con núcleos puros (clientes de GitHub y GitLab, detector de revisiones, contribuciones) que reciben un `Transport` HTTP inyectado, temporizadores y reloj como en el TypeScript, más la máquina de estados de la integración y los 8 canales `code-review:*` ya presentes en `GUARDS`. Las peticiones salen con `reqwest` y TLS del sistema (Schannel), sin proxy y sin seguir redirecciones.

**Tech Stack:** lo de las partes 1–3 más `reqwest` 0.13 (`default-features = false`, `native-tls`).

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md` (parte 4 del orden de partes).
**Mapa del código a portar:** `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_6c5a11ba-2674-4805-8266-3018f9f3d913\tauri-part4-map.md`. Cada tarea cita sus secciones; los valores exactos están ahí y en el TypeScript que nombra.

## Global Constraints

- Siguen vigentes las de las partes 1–3 (`docs/superpowers/plans/2026-11-14-tauri-part1-skeleton.md`, `2026-11-15-tauri-part2-system-notes-reminders-apps.md`, `2026-11-15-tauri-part3-claude.md`): nada de commits sin aprobación, gates de calidad (`cargo fmt --check`, clippy con y sin `--features e2e`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:rust`, `npm run test:e2e:tauri`), sin getters bloqueantes de ventana en hilos de trabajo, atajos de desarrollo solo con `ipc::dev_overrides_enabled()`, canales `__e2e:*` solo con la feature `e2e`, `src/renderer` sin cambios.
- Comportamiento idéntico al TypeScript: mismas constantes (sondeo 120 000 ms, espera progresiva 60/120/240/300 s, contribuciones cada 900 000 ms solo con la vista abierta, actualización manual como mucho cada 5 000 ms, 30 000 ms por petición), mismas consultas GraphQL y llamadas REST, mismo mapeo de códigos HTTP a estados y mismos mensajes expuestos.
- Conexión directa: sin proxy (el usuario lo confirmó), TLS con el almacén de certificados de Windows, nunca se siguen redirecciones (una 3xx es respuesta inválida y el token no se reenvía), `User-Agent` propio, cuerpo de respuesta limitado a 16 MiB.
- Los tokens se guardan cifrados con DPAPI en `code-review-github.bin` y `code-review-gitlab.bin`; los archivos de la 0.1.0 no se pueden descifrar y se descartan con un aviso en el registro (el usuario vuelve a poner los tokens, como ya decidió).
- Nunca se registran tokens, títulos, ramas, autores, cuentas ni URL de PR/MR: solo plataforma, estado, recuentos y códigos, en texto `clave=valor` y con `code-review` en la línea.
- Al abrir un PR/MR solo se usan URL guardadas en el proceso principal para los ids del último listado, y solo si su origen es exactamente `https://github.com` o el de la URL de GitLab configurada.
- No hay avisos de Windows ni sonido en el proceso principal: el sonido lo pone la interfaz.
- Longitudes como en JavaScript (`.length`, unidades UTF-16) en los recortes de texto (`clip` de 1 000, fechas de 64, ids de 256, token de 255, URL de 512), sin partir caracteres.

## Review Focus

1. **Token revocado o caducado (401):** la plataforma pasa a «Revisa el token» y deja de consultarse; la otra sigue. Prueba en Task 5 (`auth_error_stops_polling_only_that_platform`).
2. **Sin red o servidor caído:** espera progresiva hasta 300 s y estado «sin conexión», sin perder los últimos datos mostrados; al volver la red se recupera solo. Prueba en Task 5 (`backoff_then_recovers_keeping_last_data`).
3. **Servidor que redirige (por ejemplo, un GitLab tras un SSO):** respuesta inválida, sin seguir la redirección ni reenviar el token. Prueba en Task 1 (`redirect_is_invalid_response_and_never_followed`).
4. **Contribuciones en un mes con cambio de hora o una semana que empieza en el mes anterior:** los días se cuentan en hora local sin perder ni duplicar un día. Prueba en Task 4 (`month_with_dst_change_keeps_every_day_once`).
5. **Abrir un PR/MR con un id inventado o de otro origen:** error «Unknown item» o rechazo por origen, sin abrir nada. Prueba en Task 5 (`open_refuses_unknown_ids_and_foreign_origins`).

---

### Task 1: Base: cliente HTTP, tokens cifrados y contratos

**Files:**
- Modify: `src-tauri/Cargo.toml` (`reqwest` 0.13 con `default-features = false` y `native-tls`)
- Create: `src-tauri/src/code_review/{mod.rs,http.rs,client.rs}`, `src-tauri/src/services/secure_token_store.rs`, `src-tauri/src/contract/code_review.rs`
- Move: `src-tauri/src/claude/dpapi.rs` → `src-tauri/src/services/dpapi.rs` (Claude lo sigue usando desde ahí)
- Modify: `src-tauri/src/contract/mod.rs` (`check()` con los 8 canales y 3 eventos), `tests/parity/contract-cases.json`, `tests/unit/shared/parity.test.ts`, `src-tauri/src/apps/mod.rs` (`shell_open` pasa a `pub(crate)`), `src-tauri/src/settings/validate.rs` (exponer `normalize_gitlab_url`)

**Interfaces:**
- Produces:
  - `trait Transport: Send + Sync { fn send(&self, req: HttpRequest) -> BoxFuture<Result<HttpResponse, TransportError>> }` con `HttpResponse { status: u16, headers (búsqueda sin mayúsculas), body: Vec<u8> }` y `ReqwestTransport` (sin proxy, sin redirecciones, 30 s en total, cuerpo ≤ 16 MiB, `User-Agent: DeveloperNotch/<versión>`).
  - `client.rs` (mapa §5, portando `client-common.ts`): `CodeReviewError` con sus códigos, `send`/`send_ok`/`status_error` (429 → rate-limited; 403 → rate-limited solo con `x-ratelimit-remaining: 0` o `retry-after`, si no auth; 401 auth; ≥ 500 server; 3xx y otros → invalid-response), `read_json::<T>`, `map_pool`, `clip`.
  - `SecureTokenStore::new(file, scope)` con `load`, `save`, `clear`, `persistent` (mapa §11): DPAPI + base64, escritura atómica, solo memoria si DPAPI no está disponible.
  - Tipos serde de `contract/code_review.rs` para los 8 canales y 3 eventos (mapa §3–4), con los límites de `CODE_REVIEW_*`.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de los tests de `client-common` presentes en `code-review-github-client.test.ts` y `code-review-gitlab-client.test.ts` que prueban el mapeo de estados, más `secure-token-store` (1) y `code-review-schema` (14); `redirect_is_invalid_response_and_never_followed` (servidor local que responde 302), `body_over_16_mib_is_invalid_response`, `timeout_is_network_error`, `legacy_electron_token_file_is_discarded_with_a_warning`; al menos 60 casos de paridad para los canales y eventos `code-review:*`.
- [ ] **Step 2:** Run `npm run test:rust` y `npx vitest run tests/unit/shared/parity.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implementar. Comprobar que `reqwest` con `native-tls` compila sin herramientas nuevas y anotar el aumento de tamaño del exe.
- [ ] **Step 4:** Run. Expected: PASS; las 44 e2e siguen pasando.
- [ ] **Step 5: Commit** `feat(tauri): base para las revisiones de código`

### Task 2: Cliente de GitHub

**Files:**
- Create: `src-tauri/src/code_review/github.rs`

**Interfaces:**
- Consumes: Task 1 (`Transport`, `client.rs`, tipos).
- Produces (mapa §6, portando `github-client.ts`): `GithubClient::new(transport, api_base, token)` con `viewer`, `list` (consulta `CodeReview` con `toReview`, `mine`, `unreviewed`, `first: 20`; recuento exacto si la lista está completa, si no el mayor de lista y búsqueda, con tope 100; las autorrevisiones no cuentan) y `contributions(range)`; cuerpos GraphQL con el mismo orden de claves; error GraphQL `RATE_LIMITED` → rate-limited; 200 sin `data` → invalid-response.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `code-review-github-client.test.ts` (31) con un `Transport` falso.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): cliente de GitHub`

### Task 3: Cliente de GitLab

**Files:**
- Create: `src-tauri/src/code_review/gitlab.rs`

**Interfaces:**
- Consumes: Task 1.
- Produces (mapa §7, portando `gitlab-client.ts`): `GitlabClient::new(transport, base_url, token)` con `viewer`, `list` (MR propios y pendientes de revisar con `state=opened`, `per_page=20`; llamadas por MR con concurrencia 3 + 3; 403 sin límite en una llamada por MR es «falta», 401 aborta todo), `contributions(range)` (eventos con `per_page=100`, hasta 10 páginas, `x-next-page`, margen de ±2 días); URL base con su ruta conservada y consultas codificadas.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `code-review-gitlab-client.test.ts` (37) con un `Transport` falso.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): cliente de GitLab`

### Task 4: Detector de primera revisión y contribuciones

**Files:**
- Create: `src-tauri/src/code_review/{detector.rs,contributions.rs}`

**Interfaces:**
- Consumes: Task 1 (tipos).
- Produces (mapa §8–9, portando `review-detector.ts` y `src/shared/code-review/contributions.ts`): `detect_first_reviews(previous, current) -> Vec<Alert>` con la lógica de elementos inciertos (`remembered`, aritmética de no revisados); contribuciones con límites de mes, semana (lunes) y día en hora local, genéricas sobre `Tz: chrono::TimeZone` para probarlas con zonas fijas.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `code-review-detector.test.ts` (10) y `code-review-contributions.test.ts` (26); más `month_with_dst_change_keeps_every_day_once` (Europe/Madrid octubre de 2026 y America/Sao_Paulo con medianoche inexistente) y `week_starting_in_previous_month`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): detector de revisiones y contribuciones`

### Task 5: Integración, canales y conexión con la app

**Files:**
- Create: `src-tauri/src/code_review/{integration.rs,ipc.rs}`
- Modify: `src-tauri/src/lib.rs` (`Slots.code_review`, instalación tras Claude, limpieza de salida, recarga de la página del notch → `set_view_open(false)`), `src-tauri/src/e2e.rs` (`__e2e:opened-urls` y registro de URL abiertas con `NOTCH_OPEN_URL_LOG`)

**Interfaces:**
- Consumes: Tasks 1–4, `NotchController::dispatch(NotchEvent::Review{on})`, `SettingsStore`, `WallClock`, `NotchRuntime::timers()`, `QuitTasks`, `apps::shell_open`.
- Produces (mapa §10, §12–13, portando `code-review-integration.ts` y `code-review-ipc.ts`): `CodeReviewIntegration` con `ready`, `state`, `list`, `refresh`, `set_view_open`, `contributions`, `open`, `set_token`, `clear`, `start`, `dispose`; estados por plataforma (sin configurar, ok, offline tras la espera progresiva, auth-error, rate-limited); evento de alerta antes del `Review{on:true}`; `code-review:state` a las ventanas que existan y contribuciones solo al notch; `set_token` valida con `viewer()` y guarda la URL de GitLab normalizada en los ajustes; `NOTCH_CODE_REVIEW_BASE_URLS` solo en desarrollo, con la misma expresión regular de loopback.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `code-review-integration.test.ts` (37) y `code-review-ipc.test.ts` (10) con transporte, temporizadores y reloj falsos; más `auth_error_stops_polling_only_that_platform`, `backoff_then_recovers_keeping_last_data`, `open_refuses_unknown_ids_and_foreign_origins` y `no_code_review_output_carries_a_token`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar. Estado bajo un `Mutex` sin mantenerlo a través de `.await` ni al emitir o despachar; cada `.await` vuelve a comprobar la generación y si se ha cerrado, como `isStale` en el TS.
- [ ] **Step 4:** Run. Expected: PASS. Pendiente de prueba a mano por el usuario: guardar sus tokens reales de GitHub y GitLab y comprobar recuentos, listas, contribuciones y abrir un PR en el navegador.
- [ ] **Step 5: Commit** `feat(tauri): integración de revisiones de código`

### Task 6: Pruebas de extremo a extremo de la parte 4 y medición

**Files:**
- Create: `tests/e2e-tauri/code-review.spec.ts`
- Modify: `tests/e2e-tauri/helpers.ts`, `tests/e2e-tauri/wdio.conf.mts`, `docs/tauri-e2e.md`, `spikes/tauri-capsule/RESULTS.md`

**Interfaces:**
- Consumes: el servidor falso `tests/e2e/fixtures/fake-code-review.ts` (se reutiliza tal cual desde el proceso de la prueba), `--e2e-env-NOTCH_CODE_REVIEW_BASE_URLS`, `--e2e-env-NOTCH_OPEN_URL_LOG=1`, `__e2e:opened-urls`, `__e2e:advance-clock`.
- [ ] **Step 1:** Portar los 5 escenarios de `tests/e2e/code-review.spec.ts` (mapa §14) con los mismos `data-testid`, textos y comprobaciones: tokens guardados desde el Control Center, recuentos en la cápsula, aviso de primera revisión (también sobre la cápsula oculta), 401 que deja de consultar, contribuciones solo con la vista abierta, fallo de contribuciones con «Reintentar», ninguna violación en el servidor falso, ningún token en el DOM, los registros ni la carpeta de datos.
- [ ] **Step 2:** Run `npm run test:e2e:tauri`. Expected: FAIL hasta que estén todas las piezas.
- [ ] **Step 3:** Ajustar ayudantes.
- [ ] **Step 4:** Run `npm run test:e2e:tauri` dos veces seguidas. Expected: 49 PASS (44 + 5).
- [ ] **Step 5:** Run `npm run tauri:build`; medir instalador, memoria y CPU en reposo como en la parte 3 y añadir la sección «Parte 4» a `RESULTS.md`.
- [ ] **Step 6: Commit** `test(tauri): pruebas de extremo a extremo de las revisiones de código`

---

## Fuera de esta parte

Redmine (parte 5) y Gmail (parte 6) siguen respondiendo `UNAVAILABLE`. `SecureTokenStore` queda listo para que ambos lo reutilicen.
