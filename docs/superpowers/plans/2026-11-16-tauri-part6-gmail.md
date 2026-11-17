# Tauri, parte 6: Gmail — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la versión Tauri tenga Gmail como la 0.1.0: archivo de cliente propio de Google, inicio de sesión OAuth en el navegador, recuento de no leídos en la cápsula, los 5 últimos de Principal, lectura como texto con enlaces, marcar como leído, borrar, abrir en Gmail y aviso de correo nuevo.

**Architecture:** módulo `src-tauri/src/gmail/` con núcleos puros (cabeceras, detector de correo nuevo, extracción de texto MIME/HTML), OAuth con PKCE y un servidor de retorno en `127.0.0.1` sobre hyper, un cliente REST sobre el `Transport` compartido, la máquina de estados de la integración con el patrón de las partes 4–5 y los 14 canales `gmail:*` que ya están en `GUARDS`. `Spawner` y `finished()`, hoy duplicados, pasan a `services/tasks.rs`.

**Tech Stack:** lo de las partes 1–5 más `sha2` (PKCE) y el convertidor de HTML a texto que decida la tarea 2 (`html2text` o un formateador propio sobre `html5ever`, ya en `Cargo.lock`); feature `Win32_UI_Controls_Dialogs` de `windows-sys` para elegir el archivo del cliente.

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md` (parte 6 del orden de partes).
**Mapa del código a portar:** `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_6c5a11ba-2674-4805-8266-3018f9f3d913\tauri-part6-map.md`. Cada tarea cita sus secciones; los valores exactos están ahí y en el TypeScript que nombra.

## Global Constraints

- Siguen vigentes las de las partes 1–5 (`docs/superpowers/plans/2026-11-14-tauri-part1-skeleton.md` … `2026-11-16-tauri-part5-redmine.md`): nada de commits sin aprobación, gates de calidad (`cargo fmt --check`, clippy con y sin `--features e2e`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:rust`, `npm run test:e2e:tauri`), atajos de desarrollo solo con `ipc::dev_overrides_enabled()`, canales `__e2e:*` solo con la feature `e2e`, `src/renderer` sin cambios.
- Las pruebas nunca abren un navegador real, nunca llaman a Google ni usan cuentas, archivos de cliente o tokens del usuario: `Transport` falso, servidor local o el servidor falso de `tests/e2e/fixtures/fake-gmail.ts`; las URL que se abrirían van al registro de `OpenedUrls`.
- Comportamiento idéntico al TypeScript (mapa §2): recuento cada 60 000 ms en todos los modos del notch, espera progresiva 60/120/240/300 s, actualización manual como mucho cada 5 000 ms, renovar el token de acceso 60 s antes de caducar, 30 s por llamada a Google, retorno de OAuth en `/callback` con 300 s de espera real, alcance `https://mail.google.com/`, 5 recientes, tope de 100 no leídos, cuerpo de 50 000 unidades UTF-16, 50 enlaces, mismos mensajes expuestos y mismos textos de registro.
- Conexión directa sin proxy (el spec lo decide así; Electron usaba el proxy del sistema).
- Solo se cifra el token de renovación, con DPAPI, en `gmail-token.bin`; el id y el secreto del cliente quedan en los ajustes como en la 0.1.0. Los datos de la 0.1.0 no se migran: el usuario vuelve a elegir su archivo de cliente e inicia sesión.
- El archivo del cliente se elige con el diálogo nativo de Windows, se limita a 64 KiB, nunca se copia ni se registra su contenido.
- Nunca se registran tokens, secreto, cuenta, datos de correo, URL ni ids: solo estado, códigos y recuentos, en texto `clave=valor` y con `gmail` en la línea.
- Gmail no usa fechas locales en el proceso principal: la diferencia de zona horaria de la parte 4 no le afecta.

## Review Focus

1. **Token de renovación revocado o sin el alcance completo:** la sesión pasa a «caducada» (con motivo `scope` si falta el alcance) y deja de consultar. Prueba en Task 5 (casos TS de refresco denegado y de alcance).
2. **Sin red:** estado sin conexión con espera progresiva, conservando el recuento y la lista. Prueba en Task 5 (`offline_when_google_unreachable_keeps_last_count`, con `ReqwestTransport` contra un puerto local cerrado).
3. **Iniciar sesión y cancelarla, cerrar sesión o cambiar el cliente a mitad:** el retorno local se cierra, el intercambio se descarta, el estado vuelve al anterior y nunca se guarda un token de una sesión cancelada. Pruebas en Task 3 (loopback y cancelación) y Task 5 (casos TS de concurrencia del inicio de sesión).
4. **Correos con HTML raro (anidación enorme, scripts, tablas, entidades, charsets latinos):** texto igual que la 0.1.0 en los casos de prueba, sin desbordar la pila. Prueba en Task 2 (casos TS de `message-text` más `deeply_nested_html_does_not_overflow`).
5. **Abrir un enlace o un correo que no se mostró:** INVALID_INPUT o el buzón, nunca una URL arbitraria. Prueba en Task 5 (casos TS de `open`/`openLink`).

---

### Task 1: Base: contratos, cabeceras y detector de correo nuevo

**Files:**
- Modify: `src-tauri/src/http/transport.rs` (`Method::Delete`, `HttpRequest::delete`)
- Create: `src-tauri/src/services/tasks.rs` (`Spawner`, `finished`), y que `code_review` y `redmine` lo usen sin duplicarlo
- Create: `src-tauri/src/contract/gmail.rs`, `src-tauri/src/gmail/{mod.rs, headers.rs, new_mail.rs}`
- Modify: `src-tauri/src/contract/mod.rs` (14 canales y sus eventos en `check`), `tests/parity/contract-cases.json`, `tests/unit/shared/parity.test.ts`

**Interfaces:**
- Produces: `Method::Delete`; `services::tasks::{Spawner, finished}`; tipos serde de `contract/gmail.rs` (mapa §3–4) con `GmailNewMail.from/subject` opcionales no anulables, `reason` solo `scope` o `null`, enlaces solo http(s) tras el trim de JS; `gmail::headers::{display_sender, sender_address, decode_snippet}` (`&nbsp;` → espacio normal); `gmail::new_mail::NewMailDetector` (línea base que solo se reinicia con la sesión).
- [ ] **Step 1: Write the failing tests**: portar `gmail-schema` (22), `gmail-headers` (12) y `gmail-new-mail` (9); `delete_request_carries_the_method` (servidor local de `test_support`); al menos 110 casos de paridad para los canales y eventos `gmail:*`.
- [ ] **Step 2:** Run `npm run test:rust` y `npx vitest run tests/unit/shared/parity.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implementar. El traslado de `Spawner`/`finished` es mecánico: las pruebas de las partes 4 y 5 siguen sin cambios.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): base para Gmail`

### Task 2: Texto de los correos

**Files:**
- Create: `src-tauri/src/gmail/{message_text.rs, html_text.rs, message_text_tests.rs}`
- Modify: `src-tauri/Cargo.toml` (el convertidor elegido)

**Interfaces:**
- Consumes: Task 1.
- Produces (mapa §6, portando `message-text.ts`): `extract_message(payload) -> MessageText{body, links}` con recorrido MIME (profundidad 50, 500 partes), base64url tolerante como Node, windows-1252 para las etiquetas latinas, UTF-8 con pérdida y sin BOM, HTML a texto con el mismo formato que `html-to-text` en los casos de prueba (viñetas ` * `, encabezados sin prefijo, una celda de tabla por línea, enlaces ` [n]`), enlaces de texto plano, corte a 50 000 unidades UTF-16 sin partir un par sustituto.
- [ ] **Step 1: Spike** de 30 minutos: `html2text` con su decorador propio contra los casos de formato exacto. Si no los pasa todos, formateador propio sobre el tokenizador de `html5ever` (ya en `Cargo.lock`), sin recursión. Anotar la decisión y el aumento del exe en el informe.
- [ ] **Step 2: Write the failing tests**: portar todos los casos de `gmail-message-text.test.ts` (28), más `deeply_nested_html_does_not_overflow` (5 000 niveles).
- [ ] **Step 3:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 4:** Implementar.
- [ ] **Step 5:** Run. Expected: PASS.
- [ ] **Step 6: Commit** `feat(tauri): texto de los correos de Gmail`

### Task 3: OAuth

**Files:**
- Create: `src-tauri/src/gmail/{loopback.rs, auth.rs, auth_tests.rs}`
- Modify: `src-tauri/Cargo.toml` (`sha2`)

**Interfaces:**
- Consumes: Task 1, `http::Transport`, `apps::OpenExternal`, `services::secure_token_store::TokenStore`.
- Produces (mapa §7 y §11, portando `gmail-auth.ts`, `loopback.ts`, `auth-error.ts`, `token-store.ts`): `loopback::start(state, timeout)` → URI de retorno, futuro del código y cierre (solo `127.0.0.1`, puerto 0, `/callback`, respuestas 410/404/405/400/página de error/400/200 en ese orden, sigue esperando ante peticiones malas, se resuelve una vez, 300 s reales); `GmailAuthError` y `is_session_dead`; `Pkce` (verificador de 32 bytes, S256, estado de 16 bytes); el trait `GmailAuth` con `sign_in` (abre la URL de consentimiento con el abridor inyectado), `refresh`, `revoke` y cancelación, todo con 30 s explícitos; `has_required_scope`; el almacén `gmail-token.bin` con alcance de registro `gmail-token`.
- [ ] **Step 1: Write the failing tests**: portar `gmail-auth` (23), `gmail-loopback` (8) y la parte propia de Gmail de `gmail-token-store` (10).
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar. El servidor de retorno reutiliza hyper y tokio, no el módulo del puente de Claude.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): inicio de sesión de Gmail`

### Task 4: Cliente REST de Gmail

**Files:**
- Create: `src-tauri/src/gmail/{client.rs, client_tests.rs}`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (mapa §5, portando `gmail-client.ts`): `GmailApiError` (403 = límite, 404 según la llamada); trait `GmailApiClient` y `GmailClient` sobre `Transport` y un acceso al token que renueva una vez ante un 401 y reintenta una vez; recuento de no leídos, los 5 recientes con metadatos (un 404 los descarta), un mensaje completo con texto, marcar como leído y borrar (404 = hecho); `iso_date` (cabecera, si no `internalDate`, si no respuesta inválida; con milisegundos y `Z`); ids codificados como `encodeURIComponent`.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `gmail-client.test.ts` (28), más un DELETE y una redirección contra `test_support::serve`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): cliente de Gmail`

### Task 5: Integración de Gmail

**Files:**
- Create: `src-tauri/src/gmail/{integration.rs, integration_tests.rs}`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces (mapa §10–12, portando `gmail-integration.ts`): `GmailIntegration` con el patrón de `redmine/integration.rs` (estado bajo un `Mutex` nunca mantenido a través de `.await`, emisiones o el navegador; efectos con número de orden; `InFlight` por generación; comprobación de obsolescencia tras cada `.await`) y sus métodos (estado, recientes, mensaje, acciones, abrir, abrir enlace, cerrar, ver, actualizar, iniciar y cerrar sesión, cancelar, cambio de cliente, `start`, `dispose`); refresco compartido por generación con el margen de 60 s y la comprobación del alcance; un solo inicio de sesión a la vez con `signInSeq`; restauración tras un inicio fallido; guardar antes de borrar (`pendingSave`), revocar y borrar en paralelo al cerrar sesión; aviso de correo nuevo que lee los ajustes al momento; `parse_base_override` (`NOTCH_GMAIL_BASE_URL`, loopback sin trim) e `install`.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `gmail-integration.test.ts` (67; los 3 del estado del notch contra el `NotchController` real); más `offline_when_google_unreachable_keeps_last_count`, `an_older_state_snapshot_that_reaches_the_emitter_last_is_dropped` y `no_gmail_log_carries_tokens_or_mail_data`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): integración de Gmail`

### Task 6: Canales, archivo del cliente y conexión con la app

**Files:**
- Create: `src-tauri/src/gmail/{ipc.rs, ipc_tests.rs, client_file.rs}`
- Modify: `src-tauri/Cargo.toml` (`Win32_UI_Controls_Dialogs`), `src-tauri/src/lib.rs` (`Slots.gmail`, registro, instalación después de `OpenedUrls` y antes de las revisiones, recarga del notch → `set_view_open(false)`, limpieza tras sistema y antes de las revisiones)

**Interfaces:**
- Consumes: Tasks 1–5, `NotchController::dispatch(NotchEvent::Mail{..})`, `apps::OpenedUrls`, `QuitTasks`.
- Produces (mapa §4, §13 y §16.19, portando `gmail-ipc.ts`, `client-file.ts` y el cableado de `index.ts`): los 14 canales con salida comprobada contra el contrato (fuera de él → INTERNAL); `client_file::{parse_client_file, FilePicker}` con el diálogo `GetOpenFileNameW` (64 KiB antes de leer, solo `installed`, INVALID_INPUT sin repetir el contenido); `gmail:new-mail` al notch antes de `NotchEvent::Mail`.
- [ ] **Step 1: Write the failing tests**: portar `gmail-ipc` (25) y `gmail-client-file` (8); más `new_mail_event_goes_before_the_notch_alert` y `no_gmail_output_carries_a_token`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar.
- [ ] **Step 4:** Run. Expected: PASS. Pendiente de prueba a mano por el usuario: elegir su archivo de cliente de Google, iniciar sesión en el navegador real, ver el recuento y los recientes, leer un correo, marcarlo como leído y borrar uno de prueba, recibir el aviso de un correo nuevo y cerrar sesión.
- [ ] **Step 5: Commit** `feat(tauri): conexión de Gmail con la app`

### Task 7: Pruebas de extremo a extremo de la parte 6 y medición

**Files:**
- Create: `tests/e2e-tauri/gmail.spec.ts`
- Modify: `tests/e2e-tauri/helpers.ts`, `tests/e2e-tauri/wdio.conf.mts` (base de Gmail en un puerto cerrado por defecto), `docs/tauri-e2e.md`, `spikes/tauri-capsule/RESULTS.md`

**Interfaces:**
- Consumes: `tests/e2e/fixtures/fake-gmail.ts` tal cual, `--e2e-env-NOTCH_GMAIL_BASE_URL`, `NOTCH_OPEN_URL_LOG=1`, `NOTCH_TEST_CLOCK=1`, `__e2e:opened-urls` (la prueba hace de navegador: lee la URL de consentimiento y llama al retorno local), `__e2e:advance-clock`.
- [ ] **Step 1:** Portar los 9 escenarios de `tests/e2e/gmail.spec.ts` (mapa §14) con los mismos `data-testid`, textos y comprobaciones, con las lecciones de las partes 4–5 (avisos en tiempo real, `expandPanel` solo ante pérdida de foco, comprobación de que no aparecen secretos).
- [ ] **Step 2:** Run `npm run test:e2e:tauri`. Expected: FAIL hasta que estén todas las piezas.
- [ ] **Step 3:** Ajustar ayudantes.
- [ ] **Step 4:** Run `npm run test:e2e:tauri` dos veces seguidas. Expected: 61 PASS (52 + 9; la prueba de RAM puede omitirse sola).
- [ ] **Step 5:** Run `npm run tauri:build`; medir instalador, memoria y CPU en reposo como en la parte 5 y añadir la sección «Parte 6» a `RESULTS.md`, con el coste del convertidor de HTML.
- [ ] **Step 6: Commit** `test(tauri): pruebas de extremo a extremo de Gmail`

---

## Fuera de esta parte

- Instalador final, documentación, CHANGELOG 0.2.0 y retirada de Electron (parte 7).
- Los pendientes de las partes 4 y 5 (`.superpowers/sdd/2026-11-16-tauri-part4-code-review/follow-ups.md` y `progress.md` de la parte 5).
