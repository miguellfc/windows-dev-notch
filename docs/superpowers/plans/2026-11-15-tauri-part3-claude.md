# Tauri, parte 3: Claude Code — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la versión Tauri tenga la integración con Claude Code de la 0.1.0: el servidor local de hooks, la instalación de hooks con diff y copia de seguridad, los permisos y preguntas de Claude respondidos desde el notch, las sesiones, los avisos y traer Claude al frente.

**Architecture:** módulo `src-tauri/src/claude/` con núcleos puros (eventos de hook, preguntas, brokers, registro de sesiones, instalador, servicio) que reciben sus dependencias inyectadas como en el TypeScript, un servidor HTTP en `127.0.0.1` sobre tokio y hyper, y un adaptador que conecta el servicio con el notch, los avisos y los 13 canales `claude:*` ya presentes en `GUARDS`.

**Tech Stack:** lo de las partes 1 y 2 más `hyper` 1, `hyper-util`, `http-body-util` (servidor HTTP), `base64`, la feature `preserve_order` de `serde_json` y la feature `Win32_Security_Cryptography` de `windows-sys` (DPAPI).

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md` (parte 3 del orden de partes).
**Mapa del código a portar:** `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_6c5a11ba-2674-4805-8266-3018f9f3d913\tauri-part3-map.md`. Cada tarea cita sus secciones; los valores exactos están ahí y en el TypeScript que nombra.

## Global Constraints

- Siguen vigentes las de las partes 1 y 2 (`docs/superpowers/plans/2026-11-14-tauri-part1-skeleton.md` y `2026-11-15-tauri-part2-system-notes-reminders-apps.md`): Windows 11, identificador `dev.developernotch.app`, nada de commits sin aprobación, gates de calidad (`cargo fmt --check`, clippy con y sin `--features e2e`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:rust`, `npm run test:e2e:tauri`), sin getters bloqueantes de ventana en hilos de trabajo, atajos de desarrollo solo con `ipc::dev_overrides_enabled()`, canales `__e2e:*` solo con la feature `e2e`.
- Comportamiento idéntico al TypeScript: mismas constantes, mismo orden de comprobaciones, mismos códigos HTTP y cuerpos de respuesta **byte a byte** (Claude Code y las pruebas comparan el texto exacto).
- El servidor solo escucha en `127.0.0.1`, comprueba `Host` y el token `x-notch-token` (comparación de tiempo constante) **antes** de leer el cuerpo, y limita el cuerpo a 262 144 bytes con y sin `content-length`.
- El token nunca sale del proceso principal: no aparece en registros, en estados enviados a la interfaz ni en los diffs (se enmascara con `••••••`).
- Nunca se registran prompts, `tool_input`, vistas previas, textos de preguntas u opciones, rutas de archivos ni el token: solo método, ruta, código de estado o `held` y el nombre del evento.
- Los hooks solo se instalan tras confirmar, con el diff a la vista y copia de seguridad; desinstalar deja el archivo original byte a byte si no hubo otros cambios.
- Longitudes como en JavaScript: unidades UTF-16 donde el TypeScript usa `.length` o `.slice` (vista previa de 2 000, límites de preguntas).
- `src/renderer` no cambia en esta parte.

## Review Focus

1. **Claude se cierra o corta la conexión mientras espera una respuesta:** el permiso o la pregunta desaparece del notch y la alerta se apaga. Prueba en Task 3 (`client_disconnect_while_held_drops_the_pending_item`) y Task 5 (`disconnect_clears_attention`).
2. **Salir de la app con peticiones retenidas:** cada permiso recibe un 200 vacío y cada pregunta `{}` antes de que el proceso termine (como mucho 500 ms de margen). Prueba en Task 6 (`quit_releases_every_held_request_before_exit`).
3. **`settings.json` de Claude con BOM, CRLF, hooks ajenos o grupos mezclados:** el BOM se rechaza sin tocar el archivo, los finales de línea se respetan, los hooks ajenos y los grupos mixtos nunca se tocan. Pruebas en Task 4 (`bom_is_refused_untouched`, `crlf_is_preserved`, `mixed_groups_are_foreign`).
4. **Otro programa del equipo llama al puerto sin token, con otro `Host` o con un cuerpo enorme:** 403, 403 o 413, sin leer el cuerpo ni dejar nada retenido. Prueba en Task 3 (`rejects_before_reading_the_body`).
5. **Dos sesiones de Claude a la vez:** el `Stop` o el `PostToolUse` de una sesión no libera lo retenido por la otra. Prueba en Task 5 (`another_sessions_events_never_release`).

---

### Task 1: Base para Claude: dependencias, avisos con sonido, traducciones y contratos

**Files:**
- Modify: `src-tauri/Cargo.toml` (`hyper` 1 con `server` y `http1`, `hyper-util` con `tokio`, `http-body-util`, `base64`; `serde_json` con `preserve_order`; `tokio` declara `net`, `io-util` y `rt`; `windows-sys` añade `Win32_Security_Cryptography`)
- Modify: `src-tauri/src/platform/toast.rs` (parámetro de sonido y texto de error neutro), `src-tauri/src/reminders/toast.rs` (sigue silencioso)
- Modify: `tests/unit/shared/parity.test.ts` (`rustMessagePrefixes` añade `'claude.toast.'`), `tests/parity/i18n-main.json`
- Create: `src-tauri/src/contract/claude.rs`
- Modify: `src-tauri/src/contract/mod.rs` (`check()` con los 13 canales y los 2 eventos de Claude), `tests/parity/contract-cases.json`

**Interfaces:**
- Produces:
  - `platform::toast::show(title, body, sound: ToastSound /* Silent | Default */, on_click)`; el error se registra como `Toast failed` con el nombre del error.
  - Tipos serde de `contract/claude.rs` para entradas y salidas de los 13 canales `claude:*` y los eventos `claude:state-changed` y `claude:questions` (mapa §9), con `from_input()` por entrada, incluido `claude:answer` (`id` 1..=256, `answers` 1..=4, `selected` hasta 4 enteros ≥ 0, `other` hasta 2 000) y `claude:decide` (`requestId` uuid).
- [ ] **Step 1: Write the failing tests**: casos de paridad (al menos 80) para todos los canales y eventos de Claude en las tres direcciones, con los límites de `claude:answer`, uuid inválido en `claude:decide`, campos desconocidos y `null`; `reminder_toast_stays_silent`, `claude_toast_uses_default_sound`; `t_with` con `claude.toast.title` en es y en.
- [ ] **Step 2:** Run `PARITY_UPDATE=1 npx vitest run tests/unit/shared/parity.test.ts` y `npm run test:rust`. Expected: Rust FAIL.
- [ ] **Step 3:** Implementar. Comprobar que `preserve_order` no rompe ninguna prueba existente.
- [ ] **Step 4:** Run. Expected: PASS; las 28 pruebas e2e siguen pasando.
- [ ] **Step 5: Commit** `feat(tauri): base para Claude`

### Task 2: Eventos de hook y preguntas (núcleo puro)

**Files:**
- Create: `src-tauri/src/claude/{mod.rs,hook_events.rs,questions.rs}`

**Interfaces:**
- Consumes: Task 1, `contract::text` (tablas Unicode).
- Produces (mapa §3, portando `src/shared/claude/{hook-events.ts,questions.ts,types.ts}`):
  - `HOOK_EVENT_NAMES` (12, en su orden), `parse_hook_event(&Value) -> Option<HookEvent>` con `sanitize_text`, vista previa cortada a 2 000 unidades UTF-16 (`preview_truncated`, `preview_length`), `ask_user_question` válido o `None` y `ask_user_question_raw` con el orden original de claves.
  - `QUESTION_LIMITS`, `display_questions`, `build_answers(questions, answers) -> Option<Map>`, y los cuerpos de respuesta exactos: `permission_body(Decision)`, `question_answered_body(raw, answers)`, `QUESTION_RELEASE_BODY = "{}"`.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `tests/unit/shared/claude-hook-events.test.ts` (26) y `claude-questions.test.ts` (24); más `permission_bodies_match_bytes` (los dos textos exactos del mapa §3) y `answers_keep_raw_key_order`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar. Si cortar en 2 000 unidades parte un par sustituto, se corta antes del par (serde_json no puede emitir un sustituto suelto); documentarlo y probarlo.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): eventos de hook y preguntas de Claude`

### Task 3: Configuración del puente y servidor HTTP

**Files:**
- Create: `src-tauri/src/claude/{bridge_config.rs,bridge.rs,dpapi.rs}`

**Interfaces:**
- Consumes: Task 2 (`parse_hook_event`).
- Produces:
  - `bridge_config` (mapa §1): `load(path) -> BridgeConfig { port, token }` (crea uno nuevo si falta, está roto o no se descifra), `rotate_token`, `rotate_port`; archivo `claude-bridge.json` `{ "version": 1, "port", "token" }` con el token cifrado con DPAPI (`CryptProtectData`, `CRYPTPROTECT_UI_FORBIDDEN`) y en base64; puerto aleatorio en 49152..=65535; token de 32 bytes aleatorios en hexadecimal; escritura en `<archivo>.tmp` y renombrado.
  - `bridge` (mapa §2): `ClaudeBridge::start(port, token, on_event) -> Result<u16, BridgeError /* PortInUse | Other */>`, `stop()` (deja 500 ms para que salgan las respuestas y luego cierra). Comprobaciones en el orden del mapa: Host → token → ruta → método → content-type → tamaño declarado → tamaño leído → JSON → evento. Retención según `holds(event, route)`; sello `held_at` estrictamente creciente; `PendingReply { arrived_at, send(Option<String>), on_close(cb) }` donde `send` solo actúa una vez y `on_close` se dispara si el cliente corta antes de la respuesta.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `claude-bridge-config.test.ts` (8) y `claude-bridge.test.ts` (23) contra un socket real de loopback; más `rejects_before_reading_the_body` (sin token, con `Host` ajeno y con 300 KiB declarados: 403, 403 y 413 sin que el manejador vea nada) y `client_disconnect_while_held_drops_the_pending_item`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): puente HTTP de Claude`

### Task 4: Instalador de hooks

**Files:**
- Create: `src-tauri/src/claude/{hook_installer.rs,diff.rs}`

**Interfaces:**
- Consumes: Task 2 (`HOOK_EVENT_NAMES`), `services::fs_atomic::write_atomic`.
- Produces (mapa §4, portando `hook-installer.ts`): `parse_settings`, `plan_install`, `plan_uninstall`, `hook_status -> HookStatus /* Missing | Installed | Outdated */`, `diff_lines` (mismo LCS y desempate), y `HookInstaller::new(file, backup_dir, now)` con `preview`, `install`, `uninstall`. Serialización con 2 espacios y salto final como `JSON.stringify(v, null, 2) + '\n'`, CRLF si el archivo lo tenía; copias `settings.backup-AAAAMMDD-HHMMSS[-N].json` en hora local, como mucho 10; `notch-hooks.original.json` para volver al original; rutas canónicas sin el prefijo `\\?\`; el token enmascarado en los diffs.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `claude-hook-installer.test.ts` (40); más `bom_is_refused_untouched`, `crlf_is_preserved`, `mixed_groups_are_foreign` y `uninstall_restores_original_bytes`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): instalador de hooks de Claude`

### Task 5: Brokers, sesiones y alertas de preguntas

**Files:**
- Create: `src-tauri/src/claude/{permission_broker.rs,question_broker.rs,session_registry.rs,alerts.rs}`

**Interfaces:**
- Consumes: Task 2, Task 3 (`PendingReply`).
- Produces (mapa §5–7 y §10, portando `permission-broker.ts`, `question-broker.ts`, `session-registry.ts`, `question-alerts.ts`): `PermissionBroker::{hold, decide, observe, release_all, pending}` (seguimiento de llamadas abiertas con tope 256, reglas de liberación por fin de herramienta y fin de sesión); `QuestionBroker` con sus estados y respuestas `{}`/contestadas; `SessionRegistry` (estados y caducidad con el reloj real); `ClaudeFirst` según el primer sello de permisos y preguntas.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `claude-permission-broker.test.ts` (19), `claude-question-broker.test.ts` (17), `claude-session-registry.test.ts` (19) y `claude-question-alerts.test.ts` (7); más `another_sessions_events_never_release` y `disconnect_clears_attention`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar. Cada liberación quita la entrada antes de enviar la respuesta.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): permisos, preguntas y sesiones de Claude`

### Task 6: Servicio, canales, avisos, traer al frente y conexión con la app

**Files:**
- Create: `src-tauri/src/claude/{service.rs,ipc.rs,focus.rs}`
- Modify: `src-tauri/src/lib.rs` (`Slots.claude`, instalación tras el notch y antes de los recordatorios, limpieza de salida antes de la de recordatorios)

**Interfaces:**
- Consumes: Tasks 1–5, `NotchController::{dispatch, mode}`, `PANEL_MODES`, `UsageEvent::ClaudeAlert`, `platform::toast::show`, `Interval`, `QuitTasks`.
- Produces (mapa §8–12, portando `claude-service.ts`, `claude-integration.ts`, `claude-ipc.ts`, `toast.ts`, `bring-claude-to-front.ts`):
  - `ClaudeService` con `start`, `tick` (cada 60 000 ms con `Interval`), `stop` (libera todo y para el puente), `state`, `decide`, `answer`, `release_question`, `dismiss_session`, `hooks_preview`, `hooks_install`, `hooks_uninstall`, `test_connection`, `rotate_token`, `rotate_port`, `focus_app`; un único `publish()` por evento.
  - Orden contractual de cada cambio: `ClaudeFirst` → `Attention` → `claude:state-changed` → latencia de uso → aviso; y `claude:questions` → `ClaudeFirst` → `Question` → aviso. Aviso con sonido solo si el notch no está en un modo de panel; clic → `Expand`.
  - Traer Claude al frente con la misma secuencia Win32 (`EnumWindows` sobre `claude.exe`, `AttachThreadInput`, `SetForegroundWindow`), en un hilo de bloqueo; `NOTCH_DISABLE_CLAUDE_FOCUS`, `NOTCH_CLAUDE_SETTINGS` y `NOTCH_CLAUDE_PORT` solo en desarrollo.
  - Salida: la limpieza libera todas las peticiones retenidas, para el puente con su margen de 500 ms y espera a que termine.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `claude-service.test.ts` (50), `claude-toast.test.ts` (4) y `claude-bring-to-front.test.ts` (6, con una API Win32 falsa); más `quit_releases_every_held_request_before_exit` (con el puente real) y `no_claude_response_carries_the_token`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar.
- [ ] **Step 4:** Run. Expected: PASS. Pendiente de prueba a mano por el usuario: instalar los hooks desde el Control Center con su Claude Code real, aprobar y denegar un permiso desde el notch, responder una pregunta y comprobar que «Ir a Claude» trae la ventana de Claude Desktop.
- [ ] **Step 5: Commit** `feat(tauri): integración con Claude Code`

### Task 7: Pruebas de extremo a extremo de la parte 3 y medición

**Files:**
- Create: `tests/e2e-tauri/{claude.spec.ts,claude-questions.spec.ts}`
- Modify: `tests/e2e-tauri/helpers.ts`, `docs/tauri-e2e.md`, `spikes/tauri-capsule/RESULTS.md`

**Interfaces:**
- Consumes: los canales y variables de las tareas anteriores; `--e2e-env-NOTCH_CLAUDE_SETTINGS`, `--e2e-env-NOTCH_CLAUDE_PORT=0`, `--e2e-env-NOTCH_DISABLE_CLAUDE_FOCUS=1`.
- [ ] **Step 1:** Portar los 16 escenarios de `tests/e2e/{claude,claude-questions}.spec.ts` (mapa §13) con los mismos `data-testid`, textos y cuerpos exactos: instalar hooks desde el Control Center, leer URL y token del `settings.json` de prueba y enviar los hooks con `http` de Node desde la prueba; los registros se leen de `<datos>/logs/main.log`. Completar el escenario de la parte 2 que quedó a medias (línea de fallo con sesiones de Claude en el panel).
- [ ] **Step 2:** Run `npm run test:e2e:tauri`. Expected: FAIL hasta que estén todas las piezas.
- [ ] **Step 3:** Ajustar ayudantes.
- [ ] **Step 4:** Run `npm run test:e2e:tauri` dos veces seguidas. Expected: 44 PASS (28 + 16).
- [ ] **Step 5:** Run `npm run tauri:build`; medir instalador, memoria y CPU en reposo como en la parte 2 y añadir la sección «Parte 3» a `RESULTS.md`.
- [ ] **Step 6: Commit** `test(tauri): pruebas de extremo a extremo de Claude`

---

## Fuera de esta parte

GitHub y GitLab (parte 4), Redmine (parte 5) y Gmail (parte 6) siguen respondiendo `UNAVAILABLE`.
