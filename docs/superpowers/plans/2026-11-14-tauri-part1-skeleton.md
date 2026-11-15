# Tauri, parte 1: esqueleto — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que la versión Tauri de Developer Notch arranque con la interfaz React actual, sus dos ventanas, la cápsula con todos sus modos, la bandeja, el atajo global, la instancia única, los ajustes, el idioma y el registro de uso. Las integraciones de las partes 2–6 responden `UNAVAILABLE`.

**Architecture:** un crate Rust en `src-tauri/` sustituye a `src/main` para lo que cubre esta parte. La interfaz (`src/renderer`) se sirve con Vite y recibe `window.notch` de un script de inicio que usa `buildApi` (de `src/shared/ipc/build-api.ts`) sobre un único comando Tauri `notch_ipc`. Rust replica las partes puras de `src/shared` (máquina de modos, geometría, esquema de ajustes) y unas pruebas de paridad con archivos JSON compartidos comprueban que las dos versiones dicen lo mismo.

**Tech Stack:** Tauri 2 (2.12.x), Rust 1.100 stable MSVC, crate `windows`, `serde`/`serde_json`, `tokio` (el de `tauri::async_runtime`), `tracing`, `tauri-plugin-global-shortcut`, `tauri-plugin-single-instance`, `tauri-plugin-autostart`, React 19 + Vite (lo que ya hay), Vitest, WebdriverIO + `tauri-driver` para e2e.

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md`. Aprendizajes de ventana en `spikes/tauri-capsule/RESULTS.md`.

## Global Constraints

- Solo Windows 11 con WebView2 Evergreen. El instalador no lleva WebView2.
- Identificador `dev.developernotch.app`, producto `Developer Notch`, versión `0.2.0-dev` hasta la parte 7. Datos en `%APPDATA%\dev.developernotch.app`.
- `src/renderer` se cambia lo mínimo. En esta parte solo dos cambios: el aviso del rectángulo de la cápsula (Task 7) y la franja de título del Control Center (Task 9).
- Electron sigue funcionando sin cambios de comportamiento. Todo canal nuevo del contrato tiene en Electron un manejador que no hace nada.
- Nunca se registran tokens, títulos de correos, PR/MR o tareas, ni el contenido de preguntas de Claude. Las URL se registran con la misma reducción que `urlForLog` (`src/main/services/logger.ts`).
- Los atajos `NOTCH_*` de desarrollo y la feature de cargo `e2e` no existen en la compilación publicada: se leen solo con `cfg!(debug_assertions)` o `feature = "e2e"`, y el perfil de release no activa `e2e`.
- La cápsula se muestra siempre con `WebviewWindow::show()`, nunca con `ShowWindow` directo. La ventana del notch se crea con `focusable(false)` y solo pasa a `set_focusable(true)` en los modos de `PANEL_MODES`.
- `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, `npm run lint`, `npm run typecheck` y `npm test` pasan al final de cada tarea.
- No se toca `eslint.config.mjs` ni los hooks. Commits solo con aprobación del usuario y sin push.
- E2E: no se mueve el cursor real ni se controla el escritorio. Solo capturas de las ventanas de la app, y solo se cierran procesos que lanzaron las pruebas.

## Review Focus

1. **Desaparición o robo de foco de la cápsula** al pasar entre modos (peek ↔ compact ↔ panel ↔ alerta ↔ oculta): la ventana sigue visible y el primer plano sigue siendo la ventana de antes, salvo al abrir el panel. Prueba en Task 7 (`focus_never_taken_outside_panel_modes`) y e2e en Task 11.
2. **Cursor en la zona transparente** (sombra, franja bajo un panel corto): la cápsula no se ensancha y el clic pasa. El rectángulo que manda es el que informa la interfaz, no el tamaño de modo. Prueba en Task 7 (`cursor_in_shadow_is_outside`).
3. **Monitores con otra escala** (125 %, 150 %) y cambio de monitor con el atajo: la cápsula queda centrada arriba del área de trabajo y el rectángulo se escala bien. Prueba en Task 7 (`rect_scales_with_monitor`).
4. **Archivo de ajustes roto o de una versión futura:** se aparta con sello de fecha o se entra en solo lectura, sin que la app deje de arrancar. Prueba en Task 4.
5. **Atajo ocupado por otra app o inválido:** no se guarda y el atajo anterior sigue registrado. Prueba en Task 9 (`taken_shortcut_keeps_previous`).

---

### Task 1: Crate Tauri y build de la interfaz

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/*` (generados con `npx tauri icon resources/icon.png -o src-tauri/icons`), `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `vite.tauri.config.mts`, `src/shared/security/vite-csp.ts`
- Modify: `electron.vite.config.mts` (usa `vite-csp.ts`), `package.json` (devDependencies `@tauri-apps/cli` ^2 y `@tauri-apps/api` ^2; scripts), `.gitignore` (`src-tauri/target/`, `src-tauri/gen/`, `out/tauri-renderer/`), `tsconfig.node.json` (incluir `vite.tauri.config.mts`)

**Interfaces:**
- Produces: `pub fn run()` en `lib.rs`; scripts `tauri:dev`, `tauri:build`, `dev:tauri-renderer`, `build:tauri-renderer`; salida de la interfaz en `out/tauri-renderer/{notch,control-center}/index.html`.

- [ ] **Step 1:** `vite.tauri.config.mts`: misma raíz (`src/renderer`), plugins (`react`, `tailwindcss` y el `productionCsp` que hoy está en `electron.vite.config.mts`, extraído a `src/shared/security/vite-csp.ts` para que los dos configs lo compartan) y las dos entradas. `outDir: '../../out/tauri-renderer'`, `server.port: 5174`, `strictPort: true`.
- [ ] **Step 2:** `tauri.conf.json`: `build.devUrl` `http://localhost:5174`, `build.frontendDist` `../out/tauri-renderer`, `beforeDevCommand` `npm run dev:tauri-renderer`, `beforeBuildCommand` `npm run build:tauri-renderer`. `app.windows: []`, porque las ventanas se crean en Rust. `app.withGlobalTauri: false`. Bundle NSIS con `installMode: currentUser`. Release con `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`, como en la prueba.
- [ ] **Step 3:** `lib.rs::run()` construye la app sin ventanas y con `RunEvent::ExitRequested` evitado mientras no se pida salir, porque la app vive en la bandeja.
- [ ] **Step 4:** Run: `npm run tauri:build -- --no-bundle`. Expected: compila sin avisos y genera `src-tauri/target/release/developer-notch.exe`. Run `npm run build` (Electron). Expected: sigue compilando.
- [ ] **Step 5: Commit** `chore(tauri): esqueleto del crate y build de la interfaz`

### Task 2: Puente `window.notch` y despachador IPC

**Files:**
- Create: `src/tauri-bridge/bridge.ts`, `vite.bridge.config.mts`, `src-tauri/src/ipc/{mod.rs,result.rs,guard.rs,events.rs}`, `tests/unit/tauri/bridge.test.ts`
- Modify: `package.json` (script `build:bridge`, que va dentro de `build:tauri-renderer` y del `beforeDevCommand`)

**Interfaces:**
- Produces (TS): `installBridge(internals: { invoke(cmd: string, args: unknown): Promise<unknown>; listen(event: string, cb: (payload: unknown) => void): Promise<() => void> }): void`. Define `window.notch` no escribible ni configurable con `buildApi`, y `document.documentElement.dataset.runtime = 'tauri'`. El bundle IIFE sale en `src-tauri/gen/bridge.js` y se incluye con `include_str!`.
- Produces (Rust):
  - `enum IpcErrorCode { InvalidInput, Forbidden, ReadOnly, Unavailable, NotFound, Internal }`, serializado como en `src/shared/ipc/result.ts`.
  - `fn ok(data: impl Serialize) -> Value`, `fn err(code, msg) -> Value` con la forma `{ ok, data }` / `{ ok, error: { code, message } }`.
  - `#[tauri::command] async fn notch_ipc(window: WebviewWindow, channel: String, input: Option<Value>, state: State<'_, App>) -> Value`.
  - `trait Channel { fn handle(&self, ctx: &Ctx, input: Value) -> BoxFuture<Result<Value, ExposedError>> }` y un `Registry` con `HashMap<&'static str, (Box<dyn Channel>, Guard)>`.
  - `enum Guard { Any, NotchOnly, ControlCenterOnly }`.
  - `fn emit_event(app: &AppHandle, targets: &[&str], event: &str, payload: &impl Serialize)`.
  - Etiquetas de ventana `"notch"` y `"control-center"`.

- [ ] **Step 1: Write the failing tests**
  - `bridge.test.ts`:
    - `invokes notch_ipc with channel and input`: `api.settings.get()` → `invoke('notch_ipc', { channel: 'settings:get', input: undefined })`.
    - `resolves INTERNAL when invoke rejects`.
    - `window.notch is frozen and not writable`.
    - `events.on forwards to listen and returns an unsubscribe`.
  - Rust `ipc::tests`:
    - `unknown_channel_is_invalid_input`.
    - `untrusted_url_is_forbidden`: URL que no es `http://tauri.localhost/…`, ni el `devUrl` en debug.
    - `notch_only_channel_from_control_center_is_forbidden`.
    - `unmigrated_channel_is_unavailable`: cualquier canal de `channels.ts` sin implementar devuelve `UNAVAILABLE`.
    - `exposed_error_keeps_code_and_message`.
    - `internal_error_is_generic_internal`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/tauri` y `cargo test --manifest-path src-tauri/Cargo.toml ipc`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
  - La lista de canales conocidos sale de `tests/parity/channels.json` (Task 3). Rust la carga con `include_str!` y un test comprueba que el registro cubre todos.
  - Las guardas copian las de los `*ChannelGuards` actuales de `src/main`.
- [ ] **Step 4:** Run los mismos comandos. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): puente window.notch y despachador IPC`

### Task 3: Contratos en Rust y pruebas de paridad

**Files:**
- Create:
  - `tests/unit/shared/parity.test.ts`
  - `tests/parity/{channels.json,contract-cases.json,notch-traces.json,geometry.json}`
  - `src-tauri/src/contract/{mod.rs,app.rs,settings.rs,notch.rs,usage.rs}`
  - `src-tauri/src/settings/validate.rs`
  - `src-tauri/tests/parity.rs`

**Interfaces:**
- Produces (Rust):
  - Tipos `serde` con `#[serde(deny_unknown_fields, rename_all = "camelCase")]` para la entrada y salida de `app:*`, `settings:*`, `notch:*` y `usage:summary`, más los eventos `notch:mode-changed`, `notch:mail-alert`, `notch:review-alert`, `notch:redmine-alert` y `settings:changed`.
  - `Settings` y `SettingsPatch` con los mismos rangos que `src/shared/settings/schema.ts`.
  - `fn validate_settings(&Settings) -> Result<(), String>` y `fn validate_patch(&SettingsPatch) -> Result<(), String>`.
  - Validadores: `is_safe_accelerator`, `is_stored_gitlab_url` e `is_stored_redmine_url`, que portan `src/shared/settings/accelerator.ts`, `src/shared/code-review/schema.ts` y `src/shared/redmine/url.ts`.
- Produces (archivos):
  - `contract-cases.json`: `[{ channel, direction: "input"|"output"|"event", value, accept: bool }]`.
  - `channels.json`: `{ channels: string[], events: string[] }`.

- [ ] **Step 1: Write the failing tests**
  - `parity.test.ts`:
    - `channels.json matches channels.ts`.
    - `every contract case gets the expected zod verdict`.
    - Al menos 60 casos que cubran:
      - todos los campos de `settingsPatchSchema` en su límite y fuera de él;
      - `snoozeMinutes` 7;
      - `dailyTargetHours` 7.25;
      - `endOfDay.time` `24:00`;
      - `gitlabUrl` http y con barra final;
      - atajo `Space` solo;
      - parche vacío;
      - campo desconocido;
      - `version` en el parche.
    - Con `PARITY_UPDATE=1` reescribe `channels.json`, `notch-traces.json` y `geometry.json`. Sin esa variable, falla si difieren.
  - `src-tauri/tests/parity.rs`: `every_contract_case_gets_the_expected_serde_verdict`, `channels_registry_covers_channels_json`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/shared/parity.test.ts` y `cargo test --manifest-path src-tauri/Cargo.toml --test parity`. Expected: FAIL.
- [ ] **Step 3:** Implementar los tipos y validadores. Los mensajes de error no tienen que coincidir. Solo tiene que coincidir aceptar o rechazar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): contratos del esqueleto con paridad zod/serde`

### Task 4: Almacén de ajustes

**Files:**
- Create: `src-tauri/src/settings/{mod.rs,store.rs,defaults.rs}`, `src-tauri/src/services/fs_atomic.rs`

**Interfaces:**
- Consumes: `Settings`, `SettingsPatch`, `validate_settings` (Task 3).
- Produces:
  - `SettingsStore::new(path: PathBuf, defaults: Settings, now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>)`.
  - `async fn load(&self) -> Settings`, que nunca falla.
  - `fn get(&self) -> Settings`.
  - `async fn update(&self, patch: SettingsPatch) -> Result<Settings, ExposedError>`.
  - `fn on_change(&self, f: impl Fn(&Settings) + Send + Sync + 'static)`.
  - `fn default_settings(locale: &str) -> Settings`.
  - `async fn write_atomic(path, bytes) -> io::Result<()>`.
- Archivo `settings.json` con `version: 7`, la misma forma que ve la interfaz. Como no hay archivos Tauri anteriores, en esta parte no hay migraciones: un archivo con `version` menor de 7 se trata como inválido.

- [ ] **Step 1: Write the failing tests** (portados de `tests/unit/main/settings-store.test.ts`):
  - `missing_file_writes_defaults`.
  - `invalid_json_is_quarantined_with_timestamp`: el archivo pasa a `settings.corrupt-<iso con - en vez de : y .>.json` y se restauran los valores por defecto.
  - `schema_mismatch_is_quarantined`.
  - `newer_version_is_read_only_with_defaults`: `update` da `READ_ONLY`.
  - `unreadable_file_is_read_only`.
  - `updates_are_serialized_in_order`.
  - `code_review_patch_merges_one_level`.
  - `redmine_end_of_day_merges_two_levels`.
  - `invalid_patch_is_rejected_and_file_untouched`.
  - `listener_panic_does_not_break_update`.
  - `default_language_follows_locale` (`es-ES` → `es`, `fr` → `en`).
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml settings::store`. Expected: FAIL.
- [ ] **Step 3:** Implementar. La cola de actualizaciones va con `tokio::sync::Mutex`. La escritura va a `.tmp` y luego se renombra.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): almacén de ajustes`

### Task 5: Máquina de modos y geometría con trazas de paridad

**Files:**
- Create: `src-tauri/src/notch/{mod.rs,state.rs,geometry.rs}`
- Modify: `tests/unit/shared/parity.test.ts` (generadores de trazas y geometría)

**Interfaces:**
- Produces (Rust), con los mismos nombres de `src/shared/notch/state.ts` y `geometry.ts` en snake_case:
  - `NotchState`, `NotchEvent` (enum con `#[serde(tag = "type", rename_all = "kebab-case")]`), `NotchMode`, `NotchView`.
  - `fn reduce_notch(&NotchState, &NotchEvent) -> NotchState`, `fn notch_mode`, `fn is_capsule_hidden`, `fn mail_alert_shown`, `fn review_alert_shown`, `fn redmine_alert_shown`.
  - `PANEL_MODES`, `MAIL_ALERT_MS`, `STICKY_COMPACT_MS`, `REVIEW_ALERT_MS`, `REDMINE_ALERT_MS`, `CAPSULE_SIZES`.
  - `fn window_bounds_for(mode: VisibleMode, work_area: Rect) -> Rect`, `fn resize_order(from, to) -> ResizeOrder`, `fn capsule_top_for`, `WINDOW_WIDTH`.
  - `Rect { x, y, width, height }` en DIP (`f64`).

- [ ] **Step 1: Write the failing tests**
  - Generador en `parity.test.ts`: 200 secuencias de 40 eventos con semilla fija (PRNG `mulberry32(20261114)`) sobre todos los tipos de `NotchEvent`. Tras cada evento guarda `{ state, mode, mailShown, reviewShown, redmineShown }` en `notch-traces.json`.
  - Geometría: `windowBoundsFor` para cada `VisibleMode` con las áreas `{0,0,1920,1040}`, `{-1280,0,1280,984}` y `{1920,0,2560,1392}`; `resizeOrder` para todos los pares; `WINDOW_WIDTH` y `CAPSULE_SIZES`.
  - Rust: `replays_notch_traces` (cada paso igual, comparando el `serde_json::Value`), `geometry_matches_ts`.
- [ ] **Step 2:** Run `PARITY_UPDATE=1 npx vitest run tests/unit/shared/parity.test.ts`, luego `cargo test --manifest-path src-tauri/Cargo.toml notch::`. Expected: Rust FAIL.
- [ ] **Step 3:** Portar las funciones tal cual. Si el estado no cambia, `reduce_notch` devuelve un estado igual (`PartialEq`).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): máquina de modos y geometría del notch`

### Task 6: Controlador del notch y temporizadores

**Files:**
- Create: `src-tauri/src/notch/controller.rs`, `src-tauri/src/services/timers.rs`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  - `trait NotchSurface: Send + Sync { fn set_bounds(&self, Rect); fn show(&self); fn hide(&self); fn focus(&self); fn blur(&self); fn set_ignore_mouse(&self, bool); fn send_mode(&self, NotchMode); fn send_mail_alert(&self, bool); fn send_review_alert(&self, bool); fn send_redmine_alert(&self, bool); }`. En Tauri, `focus` hace `set_focusable(true)` y `set_focus()`, y `blur` hace `set_focusable(false)`.
  - `trait Timers: Send + Sync { fn set_timeout(&self, ms: u64, f: Box<dyn FnOnce() + Send>) -> TimerId; fn clear(&self, TimerId); }`, con `RealTimers` (tokio) y `TestTimers { fn advance(&self, ms: u64) }`, que porta `src/main/services/test-clock-timers.ts`.
  - `NotchController::new(surface: Arc<dyn NotchSurface>, timers: Arc<dyn Timers>, work_area: Rect, settle_timeout_ms: u64)` con `start`, `dispatch(NotchEvent)`, `settled`, `set_work_area`, `mode`, `hidden`, `dispose`, `on_mode_change(f)` y `on_hidden_change(f)`.
- [ ] **Step 1: Write the failing tests** (portar todos los casos de `tests/unit/main/notch-controller.test.ts` con una `FakeSurface` que registra llamadas). Como mínimo:
  - `grows_window_before_mode_and_shrinks_after_settle`.
  - `shrink_falls_back_after_settle_timeout`.
  - `mail_alert_ends_after_6s_and_restarts_on_new_mail`.
  - `mail_dropped_with_panel_open`.
  - `alert_kind_off_is_sent_before_on`.
  - `sticky_compact_ends_after_3s`.
  - `focus_on_entering_panel_and_blur_on_leaving`.
  - `events_before_start_only_move_state`.
  - `hidden_change_ignores_alerts_over_hidden`.
  - `dispose_ignores_everything`.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml notch::controller`. Expected: FAIL.
- [ ] **Step 3:** Portar `src/main/windows/notch-controller.ts`. El estado va bajo `Mutex`. Las llamadas a la superficie se hacen fuera del cerrojo para que un `dispatch` reentrante desde un temporizador no se bloquee.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): controlador del notch`

### Task 7: Ventana del notch, sondeo del cursor y rectángulo de la cápsula

**Files:**
- Create: `src-tauri/src/notch/{window.rs,cursor.rs}`
- Modify:
  - `src/shared/ipc/channels.ts` (añadir `notch.capsuleRect: 'notch:capsule-rect'`)
  - `src/shared/ipc/contract.ts` (`'notch:capsule-rect': { input: z.strictObject({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() }), output: ack }`)
  - `src/main/index.ts` (manejador Electron que devuelve `null`) y su guarda `fromNotchWindow`
  - `src/renderer/notch/NotchApp.tsx`: el elemento de la cápsula informa su `getBoundingClientRect()` en un `ResizeObserver` y en `onLayoutAnimationComplete`, solo si ha cambiado.
  - `tests/parity/contract-cases.json` (casos del canal nuevo)
  - `tests/unit/shared/ipc-contract.test.ts` si exige la lista

**Interfaces:**
- Consumes: Task 2 (`Registry`, `Guard::NotchOnly`), Task 6 (`NotchSurface`, `NotchController`).
- Produces:
  - `fn create_notch_window(app: &AppHandle) -> tauri::Result<WebviewWindow>`: etiqueta `"notch"`, URL `notch/index.html`, `transparent(true)`, `decorations(false)`, `always_on_top(true)`, `skip_taskbar(true)`, `shadow(false)`, `resizable(false)`, `focusable(false)`, `visible(false)`, `initialization_script(BRIDGE_JS)`.
  - `struct TauriNotchSurface`, que implementa `NotchSurface`.
  - `fn cursor_inside(capsule_dip: Rect, window_origin_px: (i32, i32), scale: f64, cursor_px: (i32, i32)) -> bool`.
  - `CursorPoller::start(app, controller, interval_ms: 33)`. Solo despacha `pointer` cuando cambia, y nunca en modo `hidden`.
  - Canal `notch:capsule-rect` (`Guard::NotchOnly`), que guarda el último rectángulo.
  - En Tauri, el canal `notch:pointer` se acepta y no hace nada, salvo con la feature `e2e` (Task 11).
  - Evento de ventana `Focused(false)` → `dispatch(Dismiss)`, como el `blur` de Electron.
- [ ] **Step 1: Write the failing tests**
  - `cursor_in_capsule_is_inside`.
  - `cursor_in_shadow_is_outside`: rectángulo `{56,6,168,36}`, cursor en `(30,20)` relativo → `false`.
  - `rect_scales_with_monitor`: escala 1,5, origen `(1920,0)`, rectángulo `{296,6,168,36}`, cursor `(1920+444+10, 9+10)` → `true`.
  - `edges_are_half_open`.
  - `focus_never_taken_outside_panel_modes`: con una `FakeSurface`, recorrer peek → compact → alert → mini → hidden → peek y comprobar que no hay llamadas a `focus`.
  - Vitest en `tests/unit/renderer`: `capsule reports its rect once per change`, con un `ResizeObserver` simulado.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml notch::` y `npx vitest run tests/unit/renderer`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
  - El sondeo lee `GetCursorPos` y la posición y escala de la ventana. Se cachean y se refrescan en `Moved` y `ScaleFactorChanged`.
  - Por defecto, hasta que llegue el primer rectángulo, se usa el tamaño del modo de `CAPSULE_SIZES` centrado.
  - `set_ignore_cursor_events(!inside)` se aplica a la vez que el despacho.
  - El cambio de monitor sigue a `index.ts`: la cápsula se queda en su monitor y solo se mueve al del cursor cuando se pulsa el atajo fuera del panel, o cuando cambian los monitores.
- [ ] **Step 4:** Run. Expected: PASS. Run `npm run tauri:dev` y comprobar a mano que peek ↔ compact, clic a través de la sombra y clic derecho (mini) funcionan.
- [ ] **Step 5: Commit** `feat(tauri): ventana del notch con sondeo del cursor`

### Task 8: Vigilancia de la ventana en primer plano

**Files:**
- Create: `src-tauri/src/platform/{foreground.rs,win32.rs}`

**Interfaces:**
- Produces:
  - `fn classify_foreground(snapshot: &ForegroundSnapshot, ctx: &ClassifyContext) -> Verdict`, con `enum Verdict { None, Hidden, Keep }`. Porta `src/main/platform/foreground-classifier.ts`.
  - `fn probe_foreground() -> Result<ForegroundSnapshot>`, con Win32: `GetForegroundWindow`, `GetWindowRect`, `MonitorFromWindow`, `GetMonitorInfoW`, `GetClassNameW` y `SHQueryUserNotificationState`.
  - `ForegroundWatcher::start(interval_ms: 500, probe, on_change)` con `refresh()`, que informa aunque no haya cambio, y `stop()`. Si `NOTCH_DISABLE_FOREGROUND_WATCH=1` en debug, no se arranca.
- [ ] **Step 1: Write the failing tests** (portados de `tests/unit/main/foreground-classifier.test.ts` y `foreground-watcher.test.ts`):
  - `own_window_keeps`.
  - `taskbar_keeps`.
  - `desktop_is_none`.
  - `fullscreen_same_monitor_hides`.
  - `presentation_elsewhere_hides`.
  - `fullscreen_elsewhere_is_none`.
  - `watcher_reports_only_changes`.
  - `refresh_reports_unchanged`.
  - `probe_error_logged_once`.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml platform::foreground`. Expected: FAIL.
- [ ] **Step 3:** Implementar y conectar con `controller.dispatch(Foreground { verdict })`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): vigilancia de pantalla completa`

### Task 9: Bandeja, atajo, inicio con Windows, instancia única y Control Center

**Files:**
- Create: `src-tauri/src/platform/{tray.rs,shortcut.rs,autostart.rs}`, `src-tauri/src/settings/update.rs`, `src-tauri/src/control_center.rs`, `src-tauri/src/i18n.rs`
- Modify:
  - `tests/unit/shared/parity.test.ts`: genera `tests/parity/i18n-main.json` con las claves `tray.*` y las que use Rust, en `es` y `en`.
  - `src/renderer/control-center/ControlCenterApp.tsx:99`: añadir la clase `titlebar-spacer` a la franja vacía `drag h-10`.
  - `src/renderer/styles/global.css`: `html[data-runtime='tauri'] .titlebar-spacer { display: none; }`.

**Interfaces:**
- Consumes: Task 4 (`SettingsStore`), Task 6 (`NotchController`).
- Produces:
  - `fn build_tray_menu(lang: Language, notch_visible: bool, launch_at_login: bool, available: bool) -> Vec<TrayItem>`: puro, porta `tray-menu.ts`.
  - `fn to_tauri_accelerator(electron: &str) -> Option<String>`: mapea `Control`, `Alt`, `Shift` y `Super`/`Win`, igual que acepta `isSafeAccelerator`.
  - `ShortcutService { fn apply(&self, acc: &str) -> Result<(), ShortcutError /* Unavailable | Invalid */>; fn current(&self) -> Option<String>; fn dispose(&self) }`.
  - `fn update_settings(patch) -> Result<Settings, ExposedError>`: porta `settings-update.ts`. Registra antes el atajo, lo deshace si falla el guardado y aplica el inicio con Windows después.
  - `fn sync_launch_at_login(enabled: bool)`: no hace nada en debug, como `!app.isPackaged`.
  - `fn open_control_center(app, page: Option<ControlCenterPage>)`: ventana `"control-center"` de 760×520 (mínimo 640×440) con título nativo, tema oscuro y efecto Mica. Si ya existe, la restaura y le da el foco. La página va en el hash, y en una ventana abierta se cambia por `eval("location.hash = …")`.
  - Instancia única: una segunda instancia hace `dispatch(Expand)`.
  - Los canales `app:get-info`, `app:get-runtime`, `app:open-control-center`, `app:hide-notch`, `settings:get` y `settings:update` funcionan. Cada cambio de ajustes emite `settings:changed` a las dos ventanas y refresca la bandeja.
- [ ] **Step 1: Write the failing tests**
  - `tray_menu_matches_ts_labels`, con `i18n-main.json`.
  - `tray_show_hide_label_follows_visibility`.
  - `accelerator_mapping`: `Control+Alt+Space` → `ctrl+alt+Space`; `Super+N` → `super+KeyN`; `Space` → `None`.
  - `taken_shortcut_keeps_previous`.
  - `failed_save_rolls_back_shortcut`.
  - `launch_at_login_applied_after_save_only`.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml platform:: settings::update`. Expected: FAIL.
- [ ] **Step 3:** Implementar con `tauri-plugin-global-shortcut`, `tauri-plugin-autostart`, `tauri-plugin-single-instance` y `TrayIconBuilder`. El clic en el icono de la bandeja hace `dispatch(Show)`. Endurecimiento de las dos ventanas:
  - `on_navigation` solo permite su propia página.
  - `on_new_window` lo deniega todo.
  - Los permisos de WebView2 se deniegan con `with_webview`.
  - Devtools solo en debug.
- [ ] **Step 4:** Run. Expected: PASS. A mano: cambiar el idioma en el Control Center cambia la bandeja y la cápsula al momento.
- [ ] **Step 5: Commit** `feat(tauri): bandeja, atajo, instancia única y Control Center`

### Task 10: Registro local, registro de uso y salida ordenada

**Files:**
- Create: `src-tauri/src/services/{logger.rs,usage.rs,quit.rs}`

**Interfaces:**
- Produces:
  - `fn init_logger(dir: PathBuf, mirror: bool)`, con `tracing` y un archivo diario en `<datos>/logs`, como `createFileLogger`.
  - `fn url_for_log(url: &str) -> String`, que porta `urlForLog`.
  - `UsageLog::new(file, now)` con `load`, `record(UsageEvent)`, `tick`, `flush` y `summary() -> UsageSummary`, que porta `src/main/services/usage-log.ts`.
  - Canal `usage:summary` (`Guard::ControlCenterOnly`).
  - Al salir: `flush` del uso con un límite de 2000 ms, y después la limpieza (vigilante, controlador, atajo, bandeja), como `createQuitFlush`.
- [ ] **Step 1: Write the failing tests**, portados de `tests/unit/main/usage-log.test.ts`, `logger.test.ts` y `quit-flush.test.ts`: los mismos casos, con nombres en snake_case.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml services::`. Expected: FAIL.
- [ ] **Step 3:** Implementar. `tick` cada 60 s y `launch` al arrancar.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tauri): registro de uso y salida ordenada`

### Task 11: Capa de pruebas `e2e` y pruebas de extremo a extremo de la app

**Files:**
- Create:
  - `src-tauri/src/e2e.rs` (`#[cfg(feature = "e2e")]`)
  - `tests/e2e-tauri/{wdio.conf.mts,app.spec.ts,helpers.ts}`
  - `docs/tauri-e2e.md` (cómo instalar `tauri-driver` con `cargo install tauri-driver --locked` y un `msedgedriver` de la misma versión que WebView2)
- Modify: `src-tauri/Cargo.toml` (`[features] e2e = []`), `package.json` (devDependencies de WebdriverIO y script `test:e2e:tauri`, que compila con `--features e2e` y lanza wdio)

**Interfaces:**
- Consumes: Task 2 (`Registry`), Task 6 (`TestTimers`), Task 7 (`notch:pointer`).
- Produces (solo con la feature `e2e`), canales `__e2e:*` registrados para las dos ventanas:
  - `window-bounds` y `foreground-is-ours`.
  - `advance-clock { ms }`, si `NOTCH_TEST_CLOCK=1`.
  - `pointer { inside }`, que despacha al controlador.
  - `shortcut`, que simula el atajo global.
  - `work-area` y `pid`.
  - `NOTCH_DISABLE_CURSOR_POLL=1`, que no arranca el sondeo.
  - `NOTCH_USER_DATA_DIR`, que redirige la carpeta de datos.
- [ ] **Step 1: Write the failing tests**: portar a `app.spec.ts` los escenarios de `tests/e2e/app.spec.ts`:
  - `renderer is isolated and locked down by CSP` (sin `require`, sin `process`, y `window.notch` congelado).
  - `capsule floats at the top, grows to the panel and shrinks back`.
  - `capsule modes: peek, compact on hover, right click pins, left click unpins`.
  - `pinned pill takes the panel from the shortcut and returns`.
  - `hide from the panel removes the capsule without quitting`.
  - `panel header icon buttons reachable with Tab`.
  - `nine tiles fit in ES and EN`.
  - `Control Center changes language live and persists it`.
  - `About shows usage and quitting saves it`.
  - Además, `capsule never takes focus in peek, compact or alert`.
- [ ] **Step 2:** Run `npm run test:e2e:tauri`. Expected: FAIL hasta conectar la capa.
- [ ] **Step 3:** Implementar `e2e.rs` y los ayudantes. Descargar `msedgedriver` y añadir dependencias de npm requiere la aprobación del usuario antes de hacerlo.
- [ ] **Step 4:** Run `npm run test:e2e:tauri`. Expected: los 10 PASS. Run también `npm run test:e2e` (Electron). Expected: sigue en verde.
- [ ] **Step 5:** Run `npm run tauri:build`. Medir el instalador y apuntarlo en `spikes/tauri-capsule/RESULTS.md` como «parte 1», con la memoria en reposo (`measure.ps1` en el scratchpad de la sesión).
- [ ] **Step 6: Commit** `test(tauri): capa e2e y pruebas de la app`

---

## Fuera de esta parte

Apertura de apps, sistema, notas, recordatorios, Claude, revisiones, Redmine y Gmail siguen respondiendo `UNAVAILABLE` en Tauri. Tienen sus propios planes, de la parte 2 a la 6. Los almacenes de la interfaz comprueban `result.ok` antes de usar los datos, así que la app no se rompe y esas vistas muestran su estado de error.
