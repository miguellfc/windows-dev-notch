# Tauri, parte 2: sistema, notas, recordatorios y apertura de apps — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la versión Tauri tenga, con el mismo comportamiento que la 0.1.0, el monitor del sistema con sus alertas, las notas, los recordatorios (con aviso nativo, perdidos al arrancar, posponer y completar) y las baldosas que abren Claude Desktop y Windows Terminal.

**Architecture:** cada área es un módulo Rust con un núcleo puro y testeable (dependencias inyectadas: reloj, temporizadores, API de Windows, almacén) más un adaptador que lo conecta a Tauri y registra sus canales en el `Registry` de la parte 1. Los canales, guardas y eventos ya existen en `tests/parity/channels.json` y en `GUARDS`: hoy responden `UNAVAILABLE` y esta parte los implementa. Los contratos se añaden a la paridad zod/serde.

**Tech Stack:** lo de la parte 1 (Tauri 2.12, Rust 1.100 MSVC, `windows-sys` 0.61, tokio, chrono) más `uuid` (v4), `tauri-winrt-notification` para los avisos con clic y `chrono-tz` solo para pruebas.

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md` (parte 2 del orden de partes).
**Mapa del código a portar:** `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_6c5a11ba-2674-4805-8266-3018f9f3d913\tauri-part2-map.md`. Cada tarea cita sus secciones; los valores exactos (constantes, fórmulas, reglas) están ahí y en el código TypeScript que nombra.

## Global Constraints

- Todas las de la parte 1 siguen vigentes (`docs/superpowers/plans/2026-11-14-tauri-part1-skeleton.md`, «Global Constraints»): Windows 11, identificador `dev.developernotch.app`, cápsula mostrada solo con `show()`, nada de commits sin aprobación, gates de calidad (`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` con y sin `--features e2e`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:rust`).
- Comportamiento idéntico al TypeScript que se porta: mismas constantes, mismas fórmulas de redondeo, mismo orden de comprobaciones, mismos mensajes de error expuestos (`INVALID_INPUT`, `NOT_FOUND`, `READ_ONLY` con el texto exacto del TS).
- Nunca se registran textos de notas o recordatorios, nombres de procesos ni contenido de errores de Windows: solo nombres de error, ids y recuentos.
- Nunca se llama a un getter bloqueante de ventana de Tauri desde un hilo de trabajo al que el hilo principal pueda esperar. El muestreo de Windows (hasta ~20 ms) nunca corre en el hilo principal.
- `src/renderer` no cambia en esta parte.
- Los atajos de pruebas (`NOTCH_APP_LAUNCH_LOG`, `NOTCH_APP_LAUNCH_FAIL`, reloj de pruebas) solo existen con `ipc::dev_overrides_enabled()`; los canales `__e2e:*` nuevos solo con la feature `e2e`.
- Archivos de datos en `settings::data_dir(app)`: `notes.json` y `reminders.json`, formato `{ "version": 1, ... }` con 2 espacios y salto de línea final, escritura atómica, cuarentena `<nombre>.corrupt-<sello>.json` con el mismo sello que los ajustes.

## Review Focus

1. **Recordatorios y cambio de hora:** un recordatorio diario a las 02:30 el día que la hora salta de 02:00 a 03:00 cae en el primer instante válido después del salto, y el de las 02:30 del día que se repite la hora cae en la primera vez. Prueba en Task 4 (`daily_reminder_in_spring_gap_lands_after_gap`, `fall_back_takes_first_occurrence`).
2. **El PC estuvo suspendido o apagado:** al reanudar o desbloquear se disparan una sola vez los vencidos; al arrancar, los vencidos con la app cerrada salen como perdidos con un solo aviso, sin contarse además como disparados. Pruebas en Task 5 (`resume_runs_a_single_check`, `missed_on_start_fires_one_missed_toast_only`).
3. **Cerrar un proceso que no se debe:** procesos de otro usuario, de otra sesión, críticos, el propio, sus hijos, PID 0/4 o un PID reutilizado nunca se cierran. Prueba en Task 7 (`kill_refuses_every_unsafe_target`).
4. **Contadores de rendimiento no disponibles** (PDH roto o equipo sin batería ni disco legible): las métricas afectadas salen `null` y el resto sigue. Prueba en Task 7 (`pdh_failure_only_nulls_disk_activity_and_network`).
5. **Portapapeles ocupado por otra app** al copiar una nota: la llamada devuelve error sin colgar la app. Prueba en Task 3 (`copy_reports_error_when_clipboard_is_busy`).

---

### Task 1: Piezas comunes para la parte 2

**Files:**
- Modify: `src-tauri/Cargo.toml` (deps `uuid = { version = "1", features = ["v4"] }`, `tauri-winrt-notification`; dev-dep `chrono-tz`; features de `windows-sys`: `Win32_System_Threading`, `Win32_System_ProcessStatus`, `Win32_System_Diagnostics_ToolHelp`, `Win32_System_SystemInformation`, `Win32_System_Power`, `Win32_Storage_FileSystem`, `Win32_Security`, `Win32_System_RemoteDesktop`, `Win32_System_Performance`, `Win32_System_DataExchange`, `Win32_System_Memory`, `Win32_System_Ole` — confirmar los nombres exactos en 0.61)
- Modify: `src-tauri/src/notch/controller.rs` (varios oyentes de cambio de modo)
- Modify: `src-tauri/src/services/timers.rs` (intervalo), `src-tauri/src/notch/runtime.rs` (exponer los temporizadores)
- Create: `src-tauri/src/services/clock.rs`, `src-tauri/src/services/json_store.rs`
- Modify: `src-tauri/src/settings/store.rs` (sacar el nombre de cuarentena a `services`), `src-tauri/src/i18n.rs`, `tests/unit/shared/parity.test.ts` (`rustMessagePrefixes` añade `'reminders.toast.'`), `src-tauri/src/services/quit.rs`

**Interfaces:**
- Produces:
  - `NotchController::add_mode_listener(&self, f: impl Fn(NotchMode) + Send + Sync + 'static)`: los oyentes se acumulan y se llaman en orden de registro. `on_mode_change` pasa a ser un alias de `add_mode_listener` (el de la bandeja sigue funcionando).
  - `struct Interval` en `timers.rs`: `Interval::start(timers: Arc<dyn Timers>, period_ms: u64, f: Arc<dyn Fn() + Send + Sync>) -> Interval` y `Interval::stop(&self)`; re-arma un `set_timeout` tras cada disparo, funciona con `TestTimers`.
  - `NotchRuntime::timers(&self) -> Arc<dyn Timers>`: los mismos temporizadores que usa el controlador (reales, o de prueba con `NOTCH_TEST_CLOCK=1`).
  - `services::clock::WallClock`: `now(&self) -> DateTime<Utc>` = reloj real + desplazamiento; `advance(&self, ms: i64)`; `WallClock::real()`. Compartido (`Arc<WallClock>`) y gestionado como estado.
  - `services::json_store::JsonStore<T: Serialize + DeserializeOwned + Validate>`: `JsonStore::new(path, name: &'static str, now: Arc<WallClock>)`, `async load(&self) -> LoadOutcome` (`Ok`, `Quarantined`, `ReadOnly`; nunca falla), `get(&self) -> T`, `async write(&self, value: T) -> Result<(), ExposedError>` (valida, escritura atómica en cola, `READ_ONLY` con el mensaje que le pase el llamador). Política de carga idéntica a `src/main/notes/notes-store.ts` (mapa 2.1): sin archivo → vacío; JSON inválido o esquema incorrecto → cuarentena; `version > 1` → solo lectura sin tocar el archivo; error de lectura o de rename → solo lectura.
  - `services::quarantine_path(path: &Path, now: DateTime<Utc>) -> PathBuf`, reutilizado por los ajustes.
  - `i18n::t_with(lang: Language, key: &str, params: &[(&str, String)]) -> String`, que sustituye `{name}` como `translate()` en `src/shared/i18n/messages.ts`.
  - `quit`: la salida acepta una lista de vaciados (`flushers`) y de limpiezas (`cleanups`) registrados por cada módulo: vaciados en paralelo con el límite de 2 000 ms; limpiezas en el orden de registro, después de la del notch.
- [ ] **Step 1: Write the failing tests**
  - `two_mode_listeners_both_run_in_order`, `tray_listener_still_runs_after_adding_another`.
  - `interval_fires_every_period_with_test_timers`, `stopped_interval_never_fires_again`.
  - `wall_clock_advance_moves_now`.
  - `json_store`: `missing_file_is_empty_ok`, `invalid_json_is_quarantined`, `schema_mismatch_is_quarantined`, `newer_version_is_read_only_and_untouched`, `unreadable_file_is_read_only`, `writes_are_serialized_and_atomic`, `read_only_write_returns_given_message`.
  - `t_with_replaces_count_in_es_and_en` con `reminders.toast.titleMany`.
  - `quit_flushes_all_registered_flushers_within_cap`, `cleanups_run_in_registration_order`.
- [ ] **Step 2:** Run `PARITY_UPDATE=1 npx vitest run tests/unit/shared/parity.test.ts` (regenera `i18n-main.json`) y `npm run test:rust`. Expected: Rust FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS; los 11 e2e de la parte 1 siguen pasando (`npm run test:e2e:tauri`).
- [ ] **Step 5: Commit** `feat(tauri): piezas comunes de la parte 2`

### Task 2: Contratos de la parte 2 con paridad

**Files:**
- Create: `src-tauri/src/contract/{system,notes,reminders,apps}.rs`
- Modify: `src-tauri/src/contract/mod.rs` (`check()` conoce los canales y eventos nuevos), `tests/unit/shared/parity.test.ts` (`portedChannels`/`portedEvents`), `tests/parity/contract-cases.json`

**Interfaces:**
- Consumes: `string_enum!`, `Validate`, `parse_input`, `present`, `nullable`, `length`, `int_in`, `MAX_SAFE_INTEGER` (parte 1).
- Produces: tipos serde para cada canal y evento del mapa (secciones 1.9–1.10, 2.2 y 2.5, 3.2 y 3.10, 4.2), con los mismos límites: `ProcessRow`, `SystemMetrics` (`kind` light | full | unavailable), `SystemAlerts`, `KillInput`, `KillResult`, `ProcessOrder`; `Note`, `NotesSnapshot`, `NoteText` (recorta y luego valida 1..=2000 y caracteres de control salvo `\n \r \t` y ZWJ); `Reminder`, `RemindersSnapshot`, `CreateReminderInput` (unión de tres formas estrictas), `UpdateReminderInput`, `ReminderFired { count }`; `OpenAppInput`, `OpenAppResult`. Constantes `NOTE_TEXT_MAX = 2000`, `NOTES_MAX = 500`, `REMINDER_TEXT_MAX = 200`, `REMINDERS_ACTIVE_MAX = 500`, `PROCESS_LIMIT = 5`.
- [ ] **Step 1: Write the failing tests**: al menos 120 casos nuevos en `contract-cases.json` que cubran cada canal y evento nuevo en las tres direcciones, incluidos: uuid con versión incorrecta, fecha ISO con desfase (`+02:00`, rechazada como en `z.iso.datetime()`), texto de nota solo con espacios, nota de 2001 caracteres, nota con `\t` (aceptada) y recordatorio con `\t` (rechazado), `repeat` sin `localTime`, `{ input, text }` mezclados (rechazado), `pid` 0, `startTime` de 41 caracteres, `disk.letter` en minúscula, `app: "notepad"`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/shared/parity.test.ts` y `cargo test --manifest-path src-tauri/Cargo.toml --test parity`. Expected: FAIL.
- [ ] **Step 3:** Implementar los tipos. Comprobar con un caso de emoji en el límite cómo cuenta zod la longitud de los textos recortados y replicarlo.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): contratos de sistema, notas, recordatorios y apps`

### Task 3: Apertura de apps y notas

**Files:**
- Create: `src-tauri/src/apps/{mod.rs,launcher.rs}`, `src-tauri/src/notes/{mod.rs,service.rs,ipc.rs}`, `src-tauri/src/platform/clipboard.rs`
- Modify: `src-tauri/src/lib.rs` (`build_registry` y `setup`), `src-tauri/src/e2e.rs`

**Interfaces:**
- Consumes: Task 1 (`JsonStore`, quit `flushers`), Task 2 (tipos), `NotchController::dispatch(NotchEvent::Dismiss)`.
- Produces:
  - `apps::launcher::AppLauncher::new(deps: LauncherDeps)` y `async open(&self, app: AppId) -> LaunchResult` (`Desktop | Browser | Wt | Pwsh | Powershell | Failed | Ignored`), portado de `src/main/apps/app-launcher.ts` (mapa 4.1): rebote de 1 000 ms por app; Claude abre `claude://claude.ai/new` y si falla `https://claude.ai/new` (`ShellExecuteW`, resultado ≤ 32 es fallo); Terminal resuelve `wt.exe`, `pwsh.exe` y PowerShell 5 con las mismas reglas de PATH (solo rutas absolutas, `%LOCALAPPDATA%\Microsoft\WindowsApps`, existencia con `symlink_metadata`), lanza separado con el entorno sin `NOTCH_*` ni `ELECTRON_*`, en la carpeta de usuario, con ventana visible.
  - Canal `apps:open`: `Failed` → `{ ok: false }`; `Ignored` → `{ ok: true }` sin cerrar el panel; el resto → `{ ok: true }` y `dispatch(Dismiss)`.
  - Con `NOTCH_APP_LAUNCH_LOG=1` (solo con `dev_overrides_enabled()`) los lanzamientos se registran en memoria en lugar de ejecutarse, y `NOTCH_APP_LAUNCH_FAIL=claude|terminal` fuerza el fallo, como en Electron. Canal `__e2e:app-launches` (feature `e2e`) devuelve el registro y la carpeta de usuario.
  - `notes::service::NotesService` portado de `src/main/notes/notes-service.ts` (mapa 2.3): `list`, `create`, `update`, `set_pinned`, `remove`, `restore` (ventana de 10 000 ms en memoria), `text(id)`, `idle()`. Ids con `uuid::Uuid::new_v4()`. Orden de `sortNotes`.
  - Canales `notes:*` (los 7) esperando a que la carga termine; evento `notes:changed` solo al notch; `notes:copy` escribe el texto en el portapapeles con `platform::clipboard::write_text(&str) -> Result<(), ClipboardError>` (Win32 `OpenClipboard`/`SetClipboardData(CF_UNICODETEXT)`, hasta 5 intentos de 20 ms si está ocupado, luego error `UNAVAILABLE`).
  - `notes.flush()` registrado en la salida; canal `__e2e:clipboard` (feature `e2e`) que lee el portapapeles.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `tests/unit/main/app-launcher.test.ts` (14), `notes-service.test.ts` (21), `notes-store.test.ts` (8, contra `JsonStore`), `notes-ipc.test.ts` (9); más `copy_reports_error_when_clipboard_is_busy` (portapapeles abierto por la prueba) y `launch_env_drops_notch_and_electron_vars`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar en `lib.rs`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): apertura de apps y notas`

### Task 4: Núcleo de recordatorios (hora local, interpretación y servicio)

**Files:**
- Create: `src-tauri/src/reminders/{mod.rs,time.rs,parse.rs,service.rs}`

**Interfaces:**
- Consumes: Task 1 (`JsonStore`, `WallClock`), Task 2 (tipos).
- Produces:
  - `time.rs` (mapa 3.3): funciones genéricas sobre `Tz: chrono::TimeZone` (producción con `chrono::Local`, pruebas con `chrono_tz::Europe::Madrid`): `start_of_local_day(tz, day, days)`, `at_local_time(tz, day, "HH:mm")` (en el hueco del cambio de hora, el primer instante válido después; en la hora repetida, la primera), `next_occurrence(tz, repeat, local_time, after)` (hasta 10 días; laborables salta sábado y domingo locales), `preset_due_at(tz, preset, now)`.
  - `parse.rs` (mapa 3.2): `parse_reminder(tz, input, now) -> Result<Parsed, ParseError>` con las mismas expresiones (relativo «en/in N min|h», diario, laborables, mañana/tomorrow, hora sola, 12 h y 24 h), errores `empty-text | no-time | too-long`.
  - `service.rs` (mapa 3.4): `RemindersService` con `list`, `create`, `update`, `snooze`, `complete`, `remove`, `mark_due`, `mark_missed_on_start`, `purge_done`, `next_due_at`, `attention_count`, `on_change`/`on_completed`; mismos mensajes (`dueAt must be in the future`, `Reminder is already done`, `limit`, `Reminder not found`).
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `tests/unit/shared/reminders-time.test.ts` (17), `reminders-parse.test.ts` (16), `tests/unit/main/reminders-service.test.ts` (60) y `reminders-store.test.ts` (7); más `daily_reminder_in_spring_gap_lands_after_gap` (Madrid, 2026-03-29 02:30 → 03:00 hora local) y `fall_back_takes_first_occurrence` (Madrid, 2026-10-25 02:30 → la primera, UTC+2).
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): núcleo de recordatorios`

### Task 5: Recordatorios en marcha (programador, avisos, energía y canales)

**Files:**
- Create: `src-tauri/src/reminders/{scheduler.rs,runtime.rs,toast.rs,ipc.rs}`, `src-tauri/src/platform/{power.rs,toast.rs}`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/e2e.rs`

**Interfaces:**
- Consumes: Task 1 (`Interval`, `WallClock`, `NotchRuntime::timers`, `t_with`, quit `cleanups`), Task 4, `UsageEvent::{RemindersFired, RemindersMissed, ReminderCompleted}`, `NotchEvent::{Reminders{due}, OpenIntegration{id: Reminders}}`.
- Produces:
  - `scheduler.rs` (mapa 3.5): `start`, `reschedule`, `check` (agrupa comprobaciones simultáneas), `dispose`; un temporizador hasta el próximo vencimiento con tope `2_147_483_647` ms, comprobación de seguridad cada 60 000 ms con `Interval`, reintento a los 30 000 ms si `mark_due` falla.
  - `runtime.rs` (mapa 3.6): `publish()` (alerta en la cápsula con `Reminders{due}`, evento `reminders:changed` al notch y al Control Center si existe, reprogramar), `start()` en el orden purgar → perdidos al arrancar → aviso de perdidos → programar → publicar; registro de uso como en el TS.
  - `toast.rs` (mapa 3.7): textos `fired`/`missed` con `t_with` y el idioma actual de los ajustes; sin botones; silencioso. `platform::toast::show(title, body, on_click)` con `tauri-winrt-notification` y el AppUserModelID `dev.developernotch.app` (`SetCurrentProcessExplicitAppUserModelID` al arrancar); en compilaciones de depuración usa el ID de PowerShell si el propio no está registrado. El clic hace `dispatch(OpenIntegration{ id: Reminders })`.
  - `platform::power::PowerEvents::start(on_event: Arc<dyn Fn(PowerEvent) + Send + Sync>)`: ventana solo de mensajes en su propio hilo con `WTSRegisterSessionNotification`; `PowerEvent::{Resume, Unlock}` desde `PBT_APMRESUMEAUTOMATIC` y `WTS_SESSION_UNLOCK`. Cada evento llama a `check()`. `stop()` en la limpieza de salida.
  - Canales `reminders:*` (los 6) esperando a la carga; `reminders:fired { count }` solo al notch.
  - Reloj de pruebas: los recordatorios usan el `WallClock` compartido; `__e2e:advance-clock { ms }` ahora avanza también el `WallClock` y luego espera a `reminders.check()`.
- [ ] **Step 1: Write the failing tests**: portar todos los casos de `reminder-scheduler.test.ts` (17), `reminders-runtime.test.ts` (11), `reminder-toast.test.ts` (7) y `reminders-ipc.test.ts` (6); más `resume_runs_a_single_check` (dos eventos de energía seguidos con una comprobación en curso → un solo `mark_due` adicional) y `missed_on_start_fires_one_missed_toast_only` (registro de uso `reminders-missed` y no `reminders-fired`).
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar.
- [ ] **Step 4:** Run. Expected: PASS. Pendiente de prueba a mano por el usuario con el instalador: un recordatorio a 1 minuto muestra el aviso de Windows y un clic en él abre el panel de recordatorios.
- [ ] **Step 5: Commit** `feat(tauri): recordatorios con avisos y eventos de energía`

### Task 6: Acceso a Windows para el monitor del sistema

**Files:**
- Create: `src-tauri/src/system/{mod.rs,win32.rs,pdh.rs}`

**Interfaces:**
- Produces `trait SystemApi: Send + Sync` con los métodos del mapa 1.2 (`cpu_count`, `self_pid`, `self_session_id`, `system_times`, `memory`, `power`, `fixed_drives`, `disk_space`, `disk_idle_percent`, `network_bytes_per_sec`, `processes`, `process_info`, `terminate`) y `Win32SystemApi::new() -> Option<Win32SystemApi>`, portando `src/main/system/win32-system.ts` llamada por llamada (mapa 1.7): `GetDiskFreeSpaceExW` usa el tercer valor (libre total); `IsProcessCritical` fallido cuenta como crítico; caché de información estática por `pid:startTime`; `startTime` en ISO UTC con milisegundos; PDH con los contadores en inglés (`PdhAddEnglishCounterW`), una consulta compartida, como mucho una recogida cada 500 ms y la primera sin valores; `cpu_count` con el número de procesadores lógicos que da Node (`os.cpus().length`, comprobar con `GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)`).
- [ ] **Step 1: Write the failing tests**: pruebas de forma contra el equipo real (como `win32-system-shape.test.ts`, 5): `memory_total_is_positive`, `processes_include_self`, `self_process_info_is_owned_and_not_critical`, `start_time_is_iso_ms_utc`, `pdh_second_collect_gives_values`; y puras: `filetime_to_iso`, `power_status_mapping` (sin batería, 255, cargando, enchufado).
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar. Cerrar todos los handles en todos los caminos; los búferes de SID viven hasta después de `EqualSid`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): acceso a Windows para el monitor del sistema`

### Task 7: Monitor del sistema y alertas

**Files:**
- Create: `src-tauri/src/system/{metrics.rs,processes.rs,alerts.rs,monitor.rs,ipc.rs}`
- Modify: `src-tauri/src/lib.rs` (oyente de modo, recarga de página → `resync`, limpieza de salida)

**Interfaces:**
- Consumes: Task 1 (`add_mode_listener`, `Interval`, `NotchRuntime::timers`, quit `cleanups`), Task 2, Task 6 (`SystemApi`).
- Produces (mapa 1.1–1.6, 1.8, 1.10–1.11, portando `metrics-sampler.ts`, `process-sampler.ts`, `alerts.ts`, `system-monitor.ts`):
  - `MetricsSampler::{light, full, disks, reset}`, `ProcessSampler::{top, kill, reset, forget_list}`, `AlertEvaluator::{evaluate, reset}`, `SystemMonitor::{set_mode, set_order, kill, resync, dispose}` con reloj monótono inyectado (`Instant` en producción).
  - Ritmos: pausa en mini, oculta y alerta; 1 000 ms en el modo sistema; 3 000 ms en el resto; calentamiento de 600 ms; reinicio de métricas tras 10 000 ms en pausa; disco libre como mucho cada 60 000 ms en el ritmo ligero.
  - El muestreo corre fuera del hilo principal (`spawn_blocking`); los ajustes `systemAlerts` se leen en cada muestra.
  - Canales `system:view` y `system:kill-process`; eventos `system:metrics` y `system:processes` solo al notch. Si `Win32SystemApi::new()` falla, se emite `{ kind: "unavailable" }`.
  - El inicio va después del registro de canales, fuera del camino de arranque, y aplica el modo actual del notch; una orden recibida antes del inicio se guarda y se aplica después.
- [ ] **Step 1: Write the failing tests**: portar con una `FakeSystemApi` todos los casos de `metrics-sampler.test.ts` (31), `process-sampler.test.ts` (36), `system-alerts.test.ts` (29), `system-monitor.test.ts` (34) y `system-ipc.test.ts` (3); más `kill_refuses_every_unsafe_target` (otro usuario, otra sesión, crítico, propio PID, hijo propio, PID 0 y 4, `startTime` distinto) y `pdh_failure_only_nulls_disk_activity_and_network`.
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): monitor del sistema y alertas`

### Task 8: Pruebas de extremo a extremo de la parte 2 y medición

**Files:**
- Create: `tests/e2e-tauri/{system.spec.ts,system-alerts.spec.ts,notes.spec.ts,reminders.spec.ts,apps.spec.ts}`
- Modify: `tests/e2e-tauri/helpers.ts`, `src-tauri/src/e2e.rs` (`__e2e:process-cpu`: tiempo de CPU acumulado del árbol de procesos de la app, incluido WebView2), `docs/tauri-e2e.md`, `spikes/tauri-capsule/RESULTS.md`

**Interfaces:**
- Consumes: todos los canales `__e2e:*` de las tareas 3 y 5 y los de la parte 1.
- [ ] **Step 1:** Portar los escenarios de `tests/e2e/{system,system-alerts,notes,reminders,apps}.spec.ts` (mapa 1.12, 2.6, 3.12, 4.3): 5 + 1 + 1 + 5 + 5 = 17 pruebas, con los mismos `data-testid` y textos. La de coste en reposo usa `__e2e:process-cpu` con el mismo umbral (menos de 0,5 % de CPU en peek). La de cerrar un proceso lanza desde Node un proceso que consume CPU y comprueba que solo se cierra ese.
- [ ] **Step 2:** Run `npm run test:e2e:tauri`. Expected: FAIL hasta que estén todas las piezas.
- [ ] **Step 3:** Ajustar ayudantes.
- [ ] **Step 4:** Run `npm run test:e2e:tauri` dos veces seguidas. Expected: 28 PASS (11 + 17).
- [ ] **Step 5:** Run `npm run tauri:build`; medir instalador y memoria en reposo con `measure.ps1` como en la parte 1 (notch en peek, sin Control Center, sin integraciones configuradas) y añadir la sección «Parte 2» a `RESULTS.md`.
- [ ] **Step 6: Commit** `test(tauri): pruebas de extremo a extremo de la parte 2`

---

## Fuera de esta parte

Claude (parte 3), GitHub y GitLab (parte 4), Redmine (parte 5) y Gmail (parte 6) siguen respondiendo `UNAVAILABLE`. Los eventos de energía de esta parte quedan listos para que Redmine los use en la parte 5.
