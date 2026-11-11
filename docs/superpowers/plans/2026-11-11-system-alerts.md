# Monitor del sistema — Hito 2: avisos por umbral — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La métrica que pasa su umbral se pinta en Rojo Fallo en la cápsula (y en la vista Sistema), con umbrales ajustables en Control Center.

**Architecture:** Un evaluador puro en main (`alerts.ts`) recibe cada muestra y los ajustes vivos y devuelve `SystemAlerts`; `system-monitor` lo adjunta a la muestra emitida y consulta el espacio de disco cada 60 s en el ritmo ligero. El renderer solo pinta. Ajustes en `settings.json` v3 con una página nueva en Control Center.

**Tech Stack:** Electron 45, TypeScript 6, React 19, zod 4, Zustand, Lucide, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-11-system-alerts-design.md`.

## Global Constraints

- Defaults: CPU ≥ **90 %** sostenido **30 s**; RAM ≥ **90 %**; batería ≤ **15 %** y no enchufada; disco < **10 %** libre (peor unidad fija).
- Histéresis fija de **5 puntos**: CPU vuelve con una muestra < umbral − 5; RAM < umbral − 5; batería > umbral + 5 o enchufada; disco con todas ≥ umbral + 5 libre.
- Rangos: cpu.percent 50–100, cpu.sustainSeconds 5–300, ram.percent 50–99, battery.percent 5–50, disk.freePercent 1–50.
- `SETTINGS_VERSION` 2 → **3**; migración añade `systemAlerts` con los defaults (todos `enabled: true`).
- Consulta de espacio de disco en el ritmo ligero cada **60 000 ms**; sin PDH; nada en `mini`/`hidden`/`alert`; `reset()` del evaluador al reanudar tras ≥ 10 s.
- Sin modo `alert`, sin toast, sin sonido para estos avisos. Color: `--color-fail` (Rojo Fallo), solo icono + cifra.
- Sin nombres de procesos en logs. i18n ES/EN. ≥ 24 px objetivos. Sin commits por tarea. No modificar `eslint.config.mjs`. Nunca manejar el escritorio del usuario.

## Review Focus

1. **CPU con una muestra `null` en la ventana** (primera tras reanudar) → no cuenta como alta ni corta el estado ya activo de forma espuria (Task 3).
2. **Ajustes cambiados con un aviso activo** (p. ej. subir el umbral por encima del valor actual) → se apaga en la siguiente muestra sin esperar la histéresis (Task 3).
3. **Unidad que desaparece** (USB fijo desconectado) mientras era la peor → el aviso pasa a la siguiente peor o se apaga (Task 3, Task 4).
4. **Aviso desactivado** con estado previo activo → se apaga al instante (Task 3).
5. **Bloque de disco que aparece/desaparece** → la cápsula no salta de ancho por una sola lectura (latch, Task 5).

---

### Task 1: Ajustes v3

**Files:** Modify `src/shared/settings/schema.ts`, `src/main/services/settings-migrations.ts`; tests `tests/unit/shared/settings-schema.test.ts`, `tests/unit/main/settings-migrations.test.ts`.

**Interfaces — Produces:** `systemAlertSettingsSchema` / `SystemAlertSettings = { cpu: { enabled: boolean; percent: number; sustainSeconds: number }; ram: { enabled: boolean; percent: number }; battery: { enabled: boolean; percent: number }; disk: { enabled: boolean; freePercent: number } }`; `DEFAULT_SYSTEM_ALERTS`; `Settings.systemAlerts`; `SETTINGS_VERSION = 3`; migración 2 → 3.

- [ ] Tests: v2 migra a v3 con `DEFAULT_SYSTEM_ALERTS`; rangos de la sección Global Constraints (bordes dentro y fuera); `settingsPatchSchema` acepta `{ systemAlerts: {...} }` completo; los tests existentes con versión fija se actualizan.
- [ ] RED → implementar → GREEN.

### Task 2: Esquema de avisos en las muestras

**Files:** Modify `src/shared/system/schema.ts`; test `tests/unit/shared/system-schema.test.ts`.

**Interfaces — Produces:** `systemAlertsSchema` / `SystemAlerts = { cpu: boolean; ram: boolean; battery: boolean; disk: { letter: string; freePercent: number } | null }`; `NO_ALERTS`; `lightSampleSchema` y `fullSampleSchema` con `alerts` obligatorio.

- [ ] Tests: muestras sin `alerts` inválidas; `disk.letter` A–Z, `freePercent` 0–100; estricto.
- [ ] RED → implementar → GREEN (ajustar fixtures de tests existentes que construyen muestras).

### Task 3: Evaluador de avisos

**Files:** Create `src/main/system/alerts.ts`; test `tests/unit/main/system-alerts.test.ts`.

**Interfaces — Produces:** `createAlertEvaluator()` → `{ evaluate(input: AlertInput, settings: SystemAlertSettings): SystemAlerts; reset(): void }` con `AlertInput = { now: number; cpuPercent: number | null; ramPercent: number | null; battery: { percent: number; pluggedIn: boolean } | null; disks: { letter: string; freePercent: number }[] | null /* null = sin dato nuevo: mantener */ }`.

- [ ] Tests (umbrales de Global Constraints):
  - CPU: activo solo si todas las muestras no nulas en `[now − sustainSeconds·1000, now]` son ≥ umbral **y** la ventana cubre al menos `sustainSeconds` (la muestra más antigua guardada es ≤ now − sustain); una muestra < umbral − 5 lo apaga; entre umbral − 5 y umbral mantiene el estado; `null` se ignora.
  - RAM/batería/disco con histéresis según Global Constraints; batería `null` o enchufada → false; disco: peor unidad con `freePercent` < umbral; `disks: null` mantiene el último resultado; unidad que desaparece → recalcula sobre las presentes.
  - Aviso `enabled: false` → false al instante. Si los ajustes de un aviso cambian respecto a la evaluación anterior, ese aviso se recalcula sin estado previo (sin histéresis), así que subir el umbral por encima del valor actual lo apaga en la siguiente evaluación.
  - `reset()` vacía la ventana de CPU y el estado.
- [ ] RED → implementar → GREEN.

### Task 4: Monitor adjunta avisos y vigila el disco

**Files:** Modify `src/main/system/system-monitor.ts`, `system-integration.ts`, `metrics-sampler.ts` (si hace falta un `disksOnly()`); tests `tests/unit/main/system-monitor.test.ts`, `metrics-sampler.test.ts`.

**Interfaces — Consumes:** Task 3; `SystemApi.fixedDrives/diskSpace`. **Produces:** `createSystemMonitor({ ..., alerts: AlertEvaluator, alertSettings: () => SystemAlertSettings })`; `metrics.disks(): { letter: string; freePercent: number }[]` (solo espacio, sin PDH).

- [ ] Tests (temporizadores falsos): cada muestra emitida lleva `alerts`; en ritmo ligero `disks()` se llama en el primer tick y luego cada 60 000 ms (no en cada tick), y los ticks intermedios pasan `disks: null`; en ritmo completo se usa `full().disks`; pausa ≥ 10 s → `alerts.reset()`; los ajustes se leen en cada tick (cambiarlos afecta al siguiente).
- [ ] Cableado: `alertSettings` lee `settings.get().systemAlerts` en vivo.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 5: Cápsula en rojo y bloque de disco

**Files:** Modify `src/renderer/notch/system/CapsuleMetrics.tsx`, `capsule-latch.ts`, `src/shared/notch/geometry.ts` (`COMPACT_WIDTHS`, `compactWidthFor`), `messages.ts`; tests `system-capsule-latch.test.ts`, `notch-geometry.test.ts`.

- [ ] Icono y cifra en `text-fail` cuando `alerts.cpu|ram|battery`; etiqueta accesible con ", alta"/", high" (CPU, RAM) o ", baja"/", low" (batería).
- [ ] Bloque `HardDrive` + `C: 6 %` en `text-fail` solo con `alerts.disk`; el latch (3 muestras) se aplica también a `disk` para mostrar/ocultar.
- [ ] Anchos: añadir variantes con disco a `COMPACT_WIDTHS` medidas con Playwright en ES/EN y peor caso `Z: 100 %` (con y sin batería); `compactWidthFor` las elige. Tests de geometría.
- [ ] `npm run typecheck && npm run lint && npm test` → PASS.

### Task 6: Vista Sistema en rojo

**Files:** Modify `src/renderer/notch/system/MetricCards.tsx`, `DiskList.tsx`.

- [ ] Cifra de la tarjeta CPU/RAM/batería en `text-fail` con su aviso; la línea de la unidad `alerts.disk.letter` con el % en `text-fail`. Sin otros cambios de layout.
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 7: Control Center → Sistema

**Files:** Create `src/renderer/control-center/SystemPage.tsx`; Modify `ControlCenterApp.tsx` (página `system`, icono `Activity`, después de Recordatorios), `messages.ts`.

- [ ] Por aviso: `Switch` (activar) + campo numérico con su rango (rechaza y muestra el rango (sin recortar); error junto al campo si está fuera); CPU además los segundos sostenidos. Texto breve: "Vuelve a la normalidad 5 puntos por debajo del umbral" / equivalente EN. Guardado con `settings:update` (parche completo de `systemAlerts`, leyendo el estado más reciente del store).
- [ ] `npm run typecheck && npm run lint` → PASS.

### Task 8: E2E, capturas y coste

**Files:** Modify `tests/e2e/system.spec.ts` (o nuevo `system-alerts.spec.ts` con el mismo `launch`).

- [ ] Ajustes sembrados con `ram.percent: 50` (y CPU desactivada): la cifra de RAM de la cápsula tiene la clase/color de fallo en ≤ 5 s; desde Control Center → Sistema subir RAM a 99 → vuelve a normal en ≤ 5 s; capturas `system-alerts-capsule-es.png` / `-en.png` y `system-alerts-settings.png`.
- [ ] Repetir la medición de CPU en reposo del hito 1 (media < 0,5 %).
- [ ] `npm run build` y `npm run test:e2e` → PASS (todos los specs).

### Task 9: Verificación y documentación

- [ ] Revisión de la rama completa con subagente.
- [ ] Actualizar DESIGN.md (estado rojo en la cápsula, bloque de disco) y PRD (hito 2 hecho).
- [ ] Manual: forzar un umbral bajo en Control Center y ver el rojo en la cápsula real.
