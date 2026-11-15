# Monitor del sistema (núcleo) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Cambio del usuario (2026-11-11):** la lista de procesos muestra el top **5** (antes 8; constante `PROCESS_LIMIT` en `src/shared/system/schema.ts`) y el panel "Sistema" mide **520×280** (antes 520×360, medido con 5 filas: sin hueco ni scroll).

**Goal:** CPU, RAM y batería siempre visibles en la cápsula, y una vista "Sistema" con red, discos y los procesos que más consumen, con cierre confirmado.

**Architecture:** Un adaptador Win32 (koffi + PDH) detrás de la interfaz `SystemApi`; muestreadores puros (`metrics-sampler`, `process-sampler`) y un orquestador (`system-monitor`) que decide el ritmo según el modo del notch; un adaptador Electron (`system-integration`) que publica eventos IPC y valida los cierres. El notch añade la integración/modo `system` y métricas en la cápsula compacta.

**Tech Stack:** Electron 45, TypeScript 6, React 19, Motion, Zustand, zod 4, koffi, Lucide, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-10-system-monitor-design.md`.

## Global Constraints

- Ritmo ligero (CPU, RAM, batería) cada **3000 ms** con la cápsula visible; ritmo completo (+ discos, red, procesos) cada **1000 ms** solo con la vista `system` abierta; **ninguna muestra** en `mini`, `hidden` ni `alert`.
- Procesos: top **5**, orden `'cpu' | 'ram'`; RAM = memoria privada.
- Cierre: solo si el PID está en la **última lista enviada**, `startTime` coincide, dueño = usuario actual, no crítico, misma sesión, no es el notch ni un descendiente suyo. Resultados `'killed' | 'gone' | 'denied' | 'not-killable'`.
- Canales `system:view` y `system:kill-process` **solo desde el webContents del notch**; eventos `system:metrics` y `system:processes` solo al notch.
- El log nunca contiene nombres de procesos ni PIDs de terceros.
- Panel `system` **520×280**; la cápsula compacta crece al ancho mínimo que no trunque ES ni EN (estimado ~300 px). Cifras en Grafito Cristal, tabulares, sin colores de alarma.
- Coste: muestra ligera < 2 ms, muestra de procesos < 20 ms; CPU de la app ≈ 0 % en reposo con la cápsula visible.
- Estilo Obsidian, iconos Lucide, i18n ES/EN, ≥ 24 px de objetivo táctil, `prefers-reduced-motion`.
- Sin commits por tarea (el usuario aprueba los commits al final). No modificar `eslint.config.mjs`. No push. Nunca manejar el escritorio del usuario; comprobaciones visuales solo con Playwright sobre las ventanas de la app.

## Review Focus

1. **PID reutilizado entre la lista y el click** → `gone`, nunca se cierra otro proceso (Task 4).
2. **PC de sobremesa sin batería** → la cápsula no reserva hueco ni muestra "—" para batería (Task 3, Task 7).
3. **Primera muestra tras arrancar o tras salir de `mini`/pantalla completa** → CPU "—" una vez, nunca un pico falso por un intervalo largo (Task 3, Task 6).
4. **Proceso con acceso denegado (elevado o protegido)** → aparece con "—" y sin botón Cerrar; nunca rompe la lista (Task 4, Task 8).
5. **koffi o PDH no disponibles** → la cápsula vuelve a hora y fecha, la vista dice "Monitor no disponible", el resto de la app sigue (Task 2, Task 6).

---

### Task 0: Prueba de las llamadas Win32/PDH (desechable)

**Files:** Create `spikes/system-monitor/probe.cjs` (fuera del lint), `docs/spikes/system-monitor-findings.md`.

- [ ] Script con koffi (ejecutado con el Electron del repo o con Node) que llama a todas las APIs de la tabla "Fuentes de datos" del spec, imprime valores y mide el tiempo de 100 muestras ligeras y de 20 listas de procesos.
- [ ] Documentar: valores obtenidos en esta máquina, coste medio y máximo, qué llamada falló y cómo (p. ej. procesos elevados con acceso denegado), y la firma koffi exacta de cada función/struct que usará la Task 2.

### Task 1: Esquemas compartidos

**Files:** Create `src/shared/system/schema.ts`; test `tests/unit/shared/system-schema.test.ts`.

**Interfaces — Produces:**
- `lightSampleSchema` / `LightSample = { cpuPercent: number | null; ram: { usedBytes: number; totalBytes: number } | null; battery: { percent: number; charging: boolean; secondsLeft: number | null } | null }`.
- `fullSampleSchema` / `FullSample = LightSample & { disks: { letter: string; usedPercent: number; freeBytes: number; activityPercent: number | null }[]; network: { upBytesPerSec: number; downBytesPerSec: number } | null }`.
- `systemMetricsSchema` = unión discriminada por `kind`: `{ kind: 'light', ...LightSample }`, `{ kind: 'full', ...FullSample }`, `{ kind: 'unavailable' }` / `SystemMetrics`.
- `processRowSchema` / `ProcessRow = { pid: number; name: string; cpuPercent: number | null; privateBytes: number | null; startTime: string; killable: boolean }`.
- `processOrderSchema = z.enum(['cpu', 'ram'])` / `ProcessOrder`; `killResultSchema = z.enum(['killed', 'gone', 'denied', 'not-killable'])` / `KillResult`; `killInputSchema = z.strictObject({ pid: z.int().positive(), startTime: z.string().max(40) })`; `viewInputSchema = z.strictObject({ open: z.boolean(), by: processOrderSchema.optional() })`.

- [ ] Tests: porcentajes 0–100, bytes ≥ 0, `letter` = una letra A–Z, objetos estrictos, `kind` desconocido inválido.
- [ ] RED → implementar → GREEN.

### Task 2: Adaptador Win32 + PDH

**Files:** Create `src/main/system/win32-system.ts`; test `tests/unit/main/win32-system-shape.test.ts` (solo forma/exports con koffi simulado; la verificación real es la Task 0 y el E2E).

**Interfaces — Produces:** `interface SystemApi { cpuCount: number; selfPid: number; selfSessionId: number; systemTimes(): { idleMs: number; kernelMs: number; userMs: number } | null; memory(): { totalBytes: number; availBytes: number } | null; power(): { hasBattery: boolean; percent: number | null; charging: boolean; secondsLeft: number | null } | null; fixedDrives(): string[]; diskSpace(letter: string): { totalBytes: number; freeBytes: number } | null; diskIdlePercent(): number | null; networkBytesPerSec(): { up: number; down: number } | null; processes(): { pid: number; parentPid: number; name: string }[]; processInfo(pid: number): { cpuMs: number; privateBytes: number; startTime: string; owner: 'self' | 'other' | 'unknown'; critical: boolean; sessionId: number } | null; terminate(pid: number, startTime: string): 'killed' | 'gone' | 'denied'; dispose(): void }` y `createWin32SystemApi(logger: Logger): SystemApi | null` (perezoso; `null` si koffi o una DLL fallan; tipos koffi con nombres `NOTCH_*` y `ensureKoffiType` como `src/main/platform/win32.ts`).

- [ ] Implementar con las firmas de la Task 0. `terminate` vuelve a abrir el proceso con `PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION`, compara `startTime` y devuelve `gone` si difiere o no existe, `denied` si `OpenProcess`/`TerminateProcess` fallan por acceso.
- [ ] Cerrar todos los handles (`CloseHandle`) y la consulta PDH en `dispose()`.
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 3: MetricsSampler

**Files:** Create `src/main/system/metrics-sampler.ts`; test `tests/unit/main/metrics-sampler.test.ts`.

**Interfaces — Consumes:** `SystemApi`, tipos de la Task 1. **Produces:** `createMetricsSampler(api: SystemApi)` → `{ light(): LightSample; full(): FullSample; reset(): void }`.

- [ ] Tests con `SystemApi` falsa: CPU % = 100 × (Δkernel + Δuser − Δidle) / (Δkernel + Δuser), redondeado a entero; primera muestra y la primera tras `reset()` → `cpuPercent: null`; Δ total 0 → repite el último valor; RAM usada = total − disponible; sin batería (`hasBattery: false`) → `battery: null`; `percent` null con batería → `battery: null`; discos solo de `fixedDrives()`, `usedPercent` redondeado; `diskIdlePercent` null → `activityPercent: null` en todos; `activity = clamp(100 − idle, 0, 100)`; red null → `network: null`; una API que lanza → su métrica a null, el resto sigue.
- [ ] RED → implementar → GREEN.

### Task 4: ProcessSampler y validación de cierre

**Files:** Create `src/main/system/process-sampler.ts`; test `tests/unit/main/process-sampler.test.ts`.

**Interfaces — Produces:** `createProcessSampler(api: SystemApi, now: () => number)` → `{ top(by: ProcessOrder, limit?: number /* PROCESS_LIMIT = 5 */): ProcessRow[]; kill(input: { pid: number; startTime: string }): KillResult; reset(): void }`.

- [ ] Tests: CPU % por proceso = Δ`cpuMs` / (Δt × `cpuCount`) × 100 entre dos llamadas, primera vez `null`; orden por CPU (null al final) y por RAM; límite 5; `processInfo` null → fila con `cpuPercent`/`privateBytes` null y `killable: false`; `killable` false para `owner !== 'self'`, `critical`, `sessionId !== selfSessionId`, `pid === selfPid` y cualquier descendiente de `selfPid` (por `parentPid`, transitivo); `kill` de un PID que no estaba en la última `top()` → `not-killable`; `startTime` distinto o proceso desaparecido → `gone`; fila no `killable` → `not-killable`; `terminate` → `denied` se propaga; `killed` cuando todo coincide.
- [ ] RED → implementar → GREEN.

### Task 5: Estado del notch y geometría

**Files:** Modify `src/shared/integrations/registry.ts`, `src/shared/notch/state.ts`, `geometry.ts`, `src/shared/ipc/contract.ts` (`notchModeSchema`), `src/shared/i18n/messages.ts` (`integration.system`: "Sistema"/"System"), `src/renderer/notch/IntegrationRow.tsx` (icono `Activity`), `src/renderer/notch/NotchApp.tsx` (placeholder del modo hasta la Task 8); tests de estado, geometría y controlador.

**Interfaces — Produces:** `integrationIds = ['terminal', 'reminders', 'system']`; modo/vista `system`; `CAPSULE_SIZES.system = { width: 520, height: 360 }`; `PANEL_MODES` incluye `system`; `WINDOW_WIDTH` sigue siendo el ancho máximo (640 de la terminal) + márgenes.

- [ ] Tests: abrir la integración `system` → modo `system`; `back` → `expanded`; altura de ventana y `growsWindow` correctos entre `system` y los demás paneles; el controlador enfoca al abrirlo.
- [ ] RED → implementar → GREEN.

### Task 6: Orquestador, IPC y cableado en main

**Files:** Create `src/main/system/system-monitor.ts`, `system-ipc.ts`, `system-integration.ts`; Modify `src/shared/ipc/channels.ts`, `contract.ts`, `src/main/index.ts`; tests `tests/unit/main/system-monitor.test.ts`, `system-ipc.test.ts`, `register-ipc.test.ts`, `tests/unit/shared/ipc-contract.test.ts`.

**Interfaces — Consumes:** Tasks 1–5. **Produces:** `createSystemMonitor({ metrics, processes, timers, onMetrics: (m: SystemMetrics) => void, onProcesses: (rows: ProcessRow[]) => void })` → `{ setMode(mode: NotchMode): void; setView(open: boolean, by?: ProcessOrder): void; kill(input): KillResult; dispose(): void }`; canales `system:view`, `system:kill-process`; eventos `system:metrics`, `system:processes`; `systemChannelGuards({ fromNotch })`.

- [ ] Tests (temporizadores falsos): modo `compact`/`peek`/panel → ligera cada 3000 ms; `system` + `setView(true)` → completa + procesos cada 1000 ms y nada de ligera; `mini`/`hidden`/`alert` → ningún temporizador activo y `reset()` de ambos muestreadores al reanudar; cambiar `by` reordena en la siguiente emisión; `dispose` cancela todo; sin `SystemApi` → un único `onMetrics({ kind: 'unavailable' })` y ningún temporizador.
- [ ] Guards: `system:view` y `system:kill-process` desde el Control Center → `FORBIDDEN`; entradas inválidas → `INVALID_INPUT`.
- [ ] Cableado: crear tras registrar IPC (sin bloquearlo); `onModeChange` del notch → `setMode`; eventos solo al webContents del notch; `dispose` en `will-quit`. Log sin nombres de procesos.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 7: Métricas en la cápsula compacta

**Files:** Create `src/renderer/shared/system-store.ts`, `src/renderer/notch/system/CapsuleMetrics.tsx`, `src/renderer/notch/system/format.ts`; Modify `NotchApp.tsx` (compact), `geometry.ts` (`CAPSULE_SIZES.compact.width`), `messages.ts`; tests `tests/unit/renderer/system-format.test.ts`, geometría.

- [ ] Store: `useSystem` + `bindSystem()` (patrón `claude-store.ts`) con la última muestra y la lista de procesos.
- [ ] `format.ts`: `formatPercent(n | null, lang) → '34 %' | '—'`, `formatBytes(n, lang)` (MB/GB, 1 decimal por debajo de 10), `formatRate(bytesPerSec, lang)` (KB/s, MB/s), `formatDuration(seconds, lang)` ("2 h 15 min"). Tests ES/EN.
- [ ] Cápsula: hora · fecha · `Cpu` CPU % · `MemoryStick` RAM % · batería (`Battery`/`BatteryCharging`/`BatteryLow` por debajo de 20 %, sin color de alarma), cifras en `text-graphite-glass tabular-nums`. Sin batería → sin hueco. `unavailable` → solo hora y fecha.
- [ ] Ajustar `CAPSULE_SIZES.compact.width` al mínimo que no trunca ES ni EN (medido con Playwright).
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 8: Vista "Sistema"

**Files:** Create `src/renderer/notch/system/SystemView.tsx`, `MetricCards.tsx`, `Sparkline.tsx`, `DiskList.tsx`, `ProcessList.tsx`, `history.ts`; Modify `NotchApp.tsx`, `messages.ts`; test `tests/unit/renderer/system-history.test.ts`.

**Interfaces — Produces:** `pushHistory(buffer: readonly number[], value: number | null, max = 60): number[]` (pura; ignora null).

- [ ] Al montar `system:view { open: true, by }`; al desmontar `{ open: false }`.
- [ ] Tarjetas: CPU % y RAM con sparkline de los últimos 60 valores (SVG `polyline`, sin animación), red ↑/↓, batería (% · cargando · tiempo restante; oculta sin batería).
- [ ] Discos: una línea por unidad (`C: 62 % · 120 GB libres · actividad 3 %`, "—" si null).
- [ ] Procesos: `Segmented` `CPU | RAM`; 5 filas (nombre truncado con `title`, CPU %, RAM); botón **Cerrar** (≥ 24 px) visible con hover o foco solo si `killable`; confirmación en línea "¿Cerrar {name} (PID {pid})?" con foco en Cancelar; mensajes de resultado (`denied` "Sin permiso", `gone` "Ya no existe", `not-killable` "No se puede cerrar") en la fila durante 3 s.
- [ ] Esc: en confirmación la cancela (stopPropagation); si no, vuelve a la fila de integraciones. `unavailable` → "Monitor no disponible".
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 9: E2E, capturas y coste

**Files:** Create `tests/e2e/system.spec.ts` (mismo `launch` que `claude.spec.ts`).

- [ ] Casos: la cápsula muestra CPU y RAM (y batería si hay); abrir la integración `system` → tarjetas y procesos visibles en < 2 s; el test lanza un proceso que consume CPU (`node -e "for(;;){}"`, para que entre en el top 5 por CPU sin saltarse el límite), lo encuentra por PID con el orden `CPU`, pulsa Cerrar → confirma → el proceso termina (`process.kill(pid, 0)` lanza) y la fila desaparece; un proceso del sistema que aparezca en la lista no tiene botón Cerrar; Esc en la confirmación no cierra la vista; capturas `test-results/system-*.png` (cápsula ES/EN, vista, confirmación).
- [ ] Medición: con la app en `compact` 60 s, `app.getAppMetrics()` → media de la suma de `cpu.percentCPUUsage` < 0,5 %; anotar el resultado.
- [ ] `npm run test:e2e` → PASS (todos los specs).

### Task 10: Verificación y documentación

- [ ] Revisión de la rama completa con subagente (seguridad del cierre, coste, log sin nombres, accesibilidad).
- [ ] Manual del usuario: cerrar un proceso propio real, comparar cifras con el Administrador de tareas, PC en batería si aplica.
- [ ] Actualizar PRD (núcleo del System Monitor hecho; hitos 2 y 3 pendientes) y DESIGN.md (cápsula compacta con métricas, vista Sistema).
