# Tauri, parte 5: Redmine — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la versión Tauri tenga Redmine como la 0.1.0: clave cifrada, horas de hoy en la cápsula, lista y detalle de tareas, cambiar estado y estimación, imputar horas, resumen de hoy/semana/mes y aviso de fin de jornada.

**Architecture:** módulo `src-tauri/src/redmine/` con un cliente REST sobre el `Transport` de la parte 4, núcleos puros (resumen de horas, programador de fin de jornada) genéricos sobre `chrono::TimeZone`, la máquina de estados de la integración con el patrón de la parte 4 (estado bajo un `Mutex`, efectos fuera del cerrojo con número de orden, comprobación de generación tras cada `.await`) y los 12 canales `redmine:*` que ya están en `GUARDS`. El código HTTP común, el de validación tipo zod, el almacén de tokens y el abridor de URL pasan a módulos compartidos, porque Gmail (parte 6) también los usará.

**Tech Stack:** lo de las partes 1–4; ningún crate nuevo.

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md` (parte 5 del orden de partes).
**Mapa del código a portar:** `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_6c5a11ba-2674-4805-8266-3018f9f3d913\tauri-part5-map.md`. Cada tarea cita sus secciones; los valores exactos están ahí y en el TypeScript que nombra.

## Global Constraints

- Siguen vigentes las de las partes 1–4 (`docs/superpowers/plans/2026-11-14-tauri-part1-skeleton.md` … `2026-11-16-tauri-part4-code-review.md`): nada de commits sin aprobación, gates de calidad (`cargo fmt --check`, clippy con y sin `--features e2e`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:rust`, `npm run test:e2e:tauri`), atajos de desarrollo solo con `ipc::dev_overrides_enabled()`, canales `__e2e:*` solo con la feature `e2e`, `src/renderer` sin cambios, las pruebas nunca usan la red real ni claves del usuario.
- Comportamiento idéntico al TypeScript (mapa §2): sondeo 300 000 ms, espera progresiva 60/120/240/300 s, resumen cada 900 000 ms solo con la vista abierta, actualización manual como mucho cada 5 000 ms, páginas de 100 (3 de tareas, 10 de imputaciones), recortes de 512/200/255, gracia de fin de jornada 3 600 000 ms con comprobación cada 60 000 ms, mismos mensajes expuestos y mismos textos de registro.
- Solo `https` para Redmine; sin proxy; la VPN es del sistema y la app no hace nada especial: Redmine inalcanzable da el mismo estado sin conexión que la 0.1.0.
- La clave se guarda cifrada con DPAPI en `redmine.bin`; el archivo de la 0.1.0 no se puede descifrar y se descarta con un aviso (el usuario vuelve a poner la clave).
- Nunca se registran la clave, asuntos, proyectos, comentarios, cuenta, URL ni el nombre del servidor: solo estado, códigos, `what`, `result`, `retryInMs` y `persistent`, en texto `clave=valor` y con `redmine` en la línea.
- `updatedAt` es milisegundos desde 1970 (número), no una cadena ISO.
- Fechas locales con `chrono::Local` (reglas de Windows), igual que la parte 4. La diferencia con ICU que quedó como pendiente en la parte 4 también afecta aquí (hoy, resumen, fin de jornada, «la fecha no puede ser futura»); se documenta como el mismo pendiente y no se corrige en esta parte.
- El cronómetro de Redmine sigue fuera (spec, «Fuera de alcance»).

## Review Focus

1. **VPN desconectada o Redmine caído:** estado «sin conexión» con espera progresiva, sin perder las horas, la lista ni la cuenta; al volver se recupera solo; guardar la clave sin VPN da `network`. Prueba en Task 4 (`offline_when_redmine_unreachable_keeps_last_data`, con `ReqwestTransport` contra un puerto local cerrado).
2. **Pasa la medianoche sin consulta nueva:** las horas de ayer dejan de mostrarse como de hoy en cuanto cambia el día. Prueba en Task 4 (caso TS «offline after midnight…»).
3. **Una escritura rechazada (403, 404, 422):** el resultado vuelve como dato con hasta 3 mensajes y la sesión sigue; solo un 401 la cierra. Prueba en Task 2 (filas de `writeReason`) y Task 4.
4. **El aviso de fin de jornada llega con un panel abierto o tras suspender el equipo:** se ofrece de nuevo dentro de la hora de gracia y nunca dos veces el mismo día. Pruebas en Task 3 (casos TS de panel abierto y de reanudación) y Task 5 (`power_resume_runs_the_end_of_day_check`).
5. **Abrir una tarea con un id inventado o con otro servidor:** «Unknown issue» o «Issue URL not allowed», sin abrir nada; la URL se construye siempre con la URL https de los ajustes. Prueba en Task 4 (casos TS de `open`).

---

### Task 1: Base: piezas compartidas y contratos

**Files:**
- Move: `src-tauri/src/code_review/{http.rs, zod.rs}` y la parte genérica de `client.rs` (`CodeReviewError`→`ApiError` con alias, `status_error`, `send*`, `read_json`, `clip`, `map_pool`) → `src-tauri/src/http/{mod.rs, transport.rs, common.rs, zod.rs}`; `code_review` las reexporta y sus pruebas siguen igual.
- Modify: `src-tauri/src/http/transport.rs` (`Method::Put`, `HttpRequest::put`), `src-tauri/src/http/zod.rs` (`number` finito y `non_negative`), `src-tauri/src/services/secure_token_store.rs` (trait `TokenStore` y su impl, sacados de `code_review/integration.rs`), `src-tauri/src/apps/mod.rs` (`opener(app)`, `origin_of`, `is_loopback_origin` compartidos), `src-tauri/src/settings/validate.rs` (`pub fn normalize_redmine_url`)
- Create: `src-tauri/src/contract/redmine.rs`; Modify: `src-tauri/src/contract/mod.rs` (12 canales y 3 eventos en `check`), `tests/parity/contract-cases.json`, `tests/unit/shared/parity.test.ts` (`portedChannels`/`portedEvents`)

**Interfaces:**
- Produces: `crate::http::{Transport, HttpRequest, HttpResponse, Method::{Get, Post, Put}, ReqwestTransport, ApiError, send, send_raw, send_ok, read_json, clip, map_pool, zod}`; `services::secure_token_store::TokenStore`; `apps::{opener, origin_of, is_loopback_origin}`; `settings::validate::normalize_redmine_url(&str) -> Option<String>`; tipos serde de `contract/redmine.rs` (mapa §3–4) con `updatedAt: Option<f64>`, `estimatedHours` presente-y-anulable con el refine «Nothing to update», `messages` opcional no anulable y la clave de día sin validar el calendario.
- [ ] **Step 1: Write the failing tests**: portar `redmine-schema.test.ts` (13); `put_request_carries_method_and_body` (servidor local de `test_support`); al menos 90 casos de paridad para los canales y eventos `redmine:*`, incluidas salidas con `key` o `url` rechazadas.
- [ ] **Step 2:** Run `npm run test:rust` y `npx vitest run tests/unit/shared/parity.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implementar. El traslado es mecánico: todas las pruebas de la parte 4 siguen pasando sin tocar sus aserciones.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): base para Redmine`

### Task 2: Cliente de Redmine

**Files:**
- Create: `src-tauri/src/redmine/{mod.rs, client.rs, client_tests.rs}`

**Interfaces:**
- Consumes: Task 1.
- Produces (mapa §5, portando `redmine-client.ts`): `RedmineClient::new(transport, base_url, key) -> Result<Self, InvalidRedmineUrl>` y `new_allowing_loopback_http`; `viewer() -> Viewer{id, name}`, `issues() -> IssueList` (paginado, sin duplicados conservando el primero, `truncated`), `issue(id) -> IssueDetail` (con `allowed_statuses` o, si falta, `statuses()`), `activities()`, `time_entries(from, to) -> Vec<Entry{date, hours}>`; `statuses` y `activities` en caché por cliente sin guardar fallos; `update_issue(id, patch) -> WriteResult` y `log_time(entry) -> WriteResult` que nunca fallan (mapa §5 «Writes», cuerpos con `claude::js_json::stringify` y el orden exacto de claves); cabeceras `x-redmine-api-key` y `accept` en todas, `content-type` solo en escrituras, nunca `authorization` ni la clave en la URL.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `redmine-client.test.ts` (49) con un `Transport` falso, más `write_body_prints_numbers_like_js` (`3`, `1.5`).
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): cliente de Redmine`

### Task 3: Resumen de horas y aviso de fin de jornada

**Files:**
- Create: `src-tauri/src/redmine/{summary.rs, end_of_day.rs, end_of_day_tests.rs}`

**Interfaces:**
- Consumes: Task 1, `code_review::contributions::{local_date, week_start, local_midnight}`, `reminders::time::resolve_local`, `services::{timers::{Timers, Interval}, clock::WallClock}`.
- Produces (mapa §6 y §8):
  - `summary.rs`: `round2`, `sum_hours`, `summarize_hours<Tz>(entries, now) -> RedmineSummary`, `summary_range<Tz>(now) -> (from, to)` (desde el lunes o el día 1, lo que sea antes).
  - `EndOfDay<Tz>::new(settings, clock, timers, today_hours: Fn() -> Option<f64>, is_connected: Fn() -> bool, on_alert: Fn(RedmineAlert) -> bool)` con `start`, `check`, `dispose`; hora de aviso con `resolve_local` (semántica de `new Date(y,m,d,h,mi)` en JS); `check` serializado con su propio cerrojo y sin llamar a `on_alert` con un cerrojo que pueda volver a entrar.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `redmine-end-of-day.test.ts` (20) con `TestTimers`, `WallClock::fixed` y Europe/Madrid; más `summary_week_starting_in_previous_month` (2 dic 2026 → `2026-11-30..2026-12-02`, semana 7, mes 3, días solo `12-01` y `12-02`), `summary_sums_float_hours_without_noise` y `end_of_day_time_in_a_dst_gap_moves_forward`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): resumen de horas y aviso de fin de jornada de Redmine`

### Task 4: Integración de Redmine

**Files:**
- Create: `src-tauri/src/redmine/{integration.rs, integration_tests.rs}`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (mapa §10–12, portando `redmine-integration.ts`): `RedmineIntegration<Tz>` con `ready`, `state`, `today_hours`, `issues`, `issue`, `activities`, `update_issue`, `log_time`, `summary`, `set_view_open`, `refresh`, `open`, `set_key`, `clear`, `start`, `dispose`; `parse_base_override(raw) -> Option<String>` (`NOTCH_REDMINE_BASE_URL`, una sola URL de loopback); estado bajo un `Mutex` nunca mantenido a través de `.await` ni al emitir; efectos `State` y `SummaryChanged` con número de orden; `InFlight` por generación para sondeo y resumen; `refreshAfterWrite` esperado antes de devolver la escritura; `open` acepta ids del último `issues()` o leídos con `issue(id)` y construye la URL con la URL https de los ajustes.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `redmine-integration.test.ts` (51) con cliente, temporizadores y reloj falsos (Madrid, sábado 14 nov 2026 10:00); más `offline_when_redmine_unreachable_keeps_last_data` (con `ReqwestTransport` real contra un puerto local cerrado: `offline`, espera progresiva y datos conservados; y `set_key` → `network`), `an_older_state_snapshot_that_reaches_the_emitter_last_is_dropped` y `no_redmine_log_carries_key_subject_or_host`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): integración de Redmine`

### Task 5: Canales y conexión con la app

**Files:**
- Create: `src-tauri/src/redmine/{ipc.rs, ipc_tests.rs}`
- Modify: `src-tauri/src/lib.rs` (`Slots.redmine`, registro, instalación tras los eventos de energía, recarga del notch → `set_view_open(false)`, `power.subscribe` para el fin de jornada, limpieza de salida en el orden de Electron: recordatorios → … → revisiones → Redmine → `power.stop()` propio → fin de jornada), `src-tauri/src/e2e.rs` (`advance_clock` llama a `end_of_day.check()` antes de `reminders.check()`)

**Interfaces:**
- Consumes: Tasks 1–4, `NotchController::{dispatch, mode}`, `PANEL_MODES`, `PowerEvents::subscribe`, `QuitTasks`.
- Produces (mapa §4 y §13, portando `redmine-ipc.ts` y el cableado de `index.ts`): los 12 canales con salida comprobada contra el contrato (fuera de él → INTERNAL); `redmine:state` a las ventanas que existan, `redmine:summary-changed` y `redmine:alert` solo al notch; `on_alert` rechaza sin notch o con un panel abierto, y si no envía `redmine:alert` antes de `Redmine{on:true}`.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `redmine-ipc.test.ts` (20); más `alert_is_refused_with_a_panel_open_or_without_notch`, `power_resume_runs_the_end_of_day_check` y `no_redmine_output_carries_the_key`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar.
- [ ] **Step 4:** Run. Expected: PASS. Pendiente de prueba a mano por el usuario: guardar su clave real con la VPN activa, comprobar horas, tareas, detalle, una imputación y el resumen; desconectar la VPN y ver «sin conexión» con los últimos datos; volver a conectarla y ver que se recupera.
- [ ] **Step 5: Commit** `feat(tauri): conexión de Redmine con la app`

### Task 6: Pruebas de extremo a extremo de la parte 5 y medición

**Files:**
- Create: `tests/e2e-tauri/redmine.spec.ts`
- Modify: `tests/e2e-tauri/helpers.ts`, `tests/e2e-tauri/wdio.conf.mts` (base de Redmine apuntando a un puerto cerrado por defecto, como las revisiones), `docs/tauri-e2e.md`, `spikes/tauri-capsule/RESULTS.md`

**Interfaces:**
- Consumes: `tests/e2e/fixtures/fake-redmine.ts` tal cual, `--e2e-env-NOTCH_REDMINE_BASE_URL`, `NOTCH_OPEN_URL_LOG=1`, `NOTCH_TEST_CLOCK=1`, `__e2e:advance-clock`, `__e2e:opened-urls`, `alignZoneWithWindows`.
- [ ] **Step 1:** Portar los 3 escenarios de `tests/e2e/redmine.spec.ts` (mapa §14) con los mismos `data-testid`, textos y comprobaciones; la hora de diferencia entre Windows e ICU se trata como en `code-review.spec.ts` (solo se omite lo que depende del «hoy» de la interfaz, con un registro).
- [ ] **Step 2:** Run `npm run test:e2e:tauri`. Expected: FAIL hasta que estén todas las piezas.
- [ ] **Step 3:** Ajustar ayudantes.
- [ ] **Step 4:** Run `npm run test:e2e:tauri` dos veces seguidas. Expected: 52 PASS (49 + 3).
- [ ] **Step 5:** Run `npm run tauri:build`; medir instalador, memoria y CPU en reposo como en la parte 4 y añadir la sección «Parte 5» a `RESULTS.md`.
- [ ] **Step 6: Commit** `test(tauri): pruebas de extremo a extremo de Redmine`

---

## Fuera de esta parte

- Gmail (parte 6), instalador final, documentación, CHANGELOG 0.2.0 y retirada de Electron (parte 7).
- Los pendientes de la parte 4 (`.superpowers/sdd/2026-11-16-tauri-part4-code-review/follow-ups.md`): la diferencia de zona horaria entre Rust e ICU, el foco del panel con el Control Center abierto y las dos pruebas intermitentes.
- El cronómetro de Redmine.
