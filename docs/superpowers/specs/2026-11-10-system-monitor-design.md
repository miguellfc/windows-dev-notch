# Monitor del sistema (núcleo) — Diseño

**Fecha:** 2026-11-10 · **Rama:** `feat/system-monitor` (desde `dev`)
> **Cambio del usuario (2026-11-11):** la lista de procesos muestra el top **5** (antes 8; constante `PROCESS_LIMIT` en `src/shared/system/schema.ts`) y el panel "Sistema" mide **520×280** (antes 520×360, medido con 5 filas: sin hueco ni scroll).
**Fuentes:** PRD (Could "System Monitor", adelantado tras el MVP), `PRODUCT.md`, `DESIGN.md`, patrón de integraciones de M2 (terminal) y M4 (recordatorios).

## Objetivo

Ver de un vistazo cuánto se está cargando el PC (CPU, RAM, batería siempre en la cápsula; red y disco en su vista) y encontrar y cerrar el proceso que se lo está comiendo, sin abrir el Administrador de tareas.

## Alcance y división (decidido con el usuario)

Este documento cubre solo el **núcleo**. El monitor completo se divide en tres hitos, en este orden:

1. **Núcleo** (este spec): métricas, cápsula, vista "Sistema", procesos y cierre con confirmación.
2. **Avisos**: umbrales configurables (RAM alta, disco casi lleno, CPU sostenida al 100 %, batería baja) que ponen la cápsula en alerta. Spec propio.
3. **Batería de dispositivos Bluetooth**: empieza con una prueba de viabilidad en la máquina del usuario (Windows no la expone de forma uniforme). Spec propio tras la prueba.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Dónde se ve | **Cápsula compacta siempre** (hora, fecha, CPU, RAM, batería) **y** una vista propia en la fila de integraciones |
| Cápsula | Hora · fecha · CPU % · RAM % · batería % (la batería solo si el PC tiene) |
| Procesos | Los 5 que más consumen, ordenables por CPU o RAM, con **Cerrar + confirmación** |
| Cierre | Solo procesos del usuario actual; nunca críticos, del sistema, de otros usuarios ni el propio notch |
| Fuente de datos | **Win32 con koffi + contadores PDH**, en el propio proceso main. Descartados `systeminformation` y PowerShell/WMI (lanzan procesos, cientos de ms y picos de CPU por consulta; incompatibles con "CPU ≈ 0 % en reposo") |
| Color | Cifras en neutro (Grafito Cristal) hasta el hito de avisos; sin colores de alarma en este hito |

## Fuentes de datos

| Métrica | API |
|---|---|
| CPU total % | `GetSystemTimes` (kernel32), diferencia entre dos muestras |
| RAM usada / total | `GlobalMemoryStatusEx` |
| Batería %, cargando, tiempo restante, ¿hay batería? | `GetSystemPowerStatus` (`BatteryFlag` 128 = sin batería) |
| Espacio por unidad | `GetLogicalDrives` + `GetDriveTypeW` (solo fijas) + `GetDiskFreeSpaceExW` |
| Actividad de disco % | PDH `\PhysicalDisk(_Total)\% Idle Time` (actividad = 100 − idle), consultas en inglés con `PdhAddEnglishCounterW` |
| Red ↑/↓ bytes/s | PDH `\Network Interface(*)\Bytes Sent/sec` y `Bytes Received/sec`, sumando interfaces |
| Procesos | `CreateToolhelp32Snapshot` + `Process32NextW` (pid, nombre); `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetProcessTimes` (CPU por diferencia, hora de inicio) + `K32GetProcessMemoryInfo` (memoria privada) |
| Dueño y criticidad | `OpenProcessToken` + `GetTokenInformation(TokenUser)` comparado con el SID del usuario actual; `IsProcessCritical`; `ProcessIdToSessionId` |

Primera tarea del plan: **prueba aislada** que confirme con koffi en esta máquina que todas las llamadas devuelven datos coherentes y cuánto cuesta una muestra (objetivo: < 2 ms la muestra ligera, < 20 ms la de procesos). Si PDH falla, la actividad de disco y la red muestran "—" y el resto sigue.

## Arquitectura

### Main (`src/main/system/`)

- **`win32-system.ts`**: adaptador koffi + PDH con interfaz inyectable (`SystemApi`), cargado de forma perezosa; devuelve `null` si koffi o una DLL fallan (como `win32.ts`).
- **`metrics-sampler.ts`** (puro con `SystemApi` y reloj inyectados):
  - `sampleLight()` → `{ cpu, ram: { used, total }, battery: { percent, charging, secondsLeft } | null }`.
  - `sampleFull()` → lo anterior + `disks: [{ letter, usedPercent, freeBytes, activityPercent | null }]`, `network: { upBytesPerSec, downBytesPerSec } | null`.
  - CPU por diferencia entre dos lecturas; la primera muestra devuelve `cpu: null`.
- **`process-sampler.ts`** (puro): `top({ by: 'cpu' | 'ram', limit: 5 })` → `[{ pid, name, cpuPercent, privateBytes, startTime, killable }]`. CPU por proceso = Δ tiempo de proceso / (Δ tiempo × núcleos). `killable` = del usuario actual ∧ no crítico ∧ no es el notch ni sus procesos hijos ∧ sesión del usuario.
- **`system-monitor.ts`** (orquestador con temporizadores inyectados):
  - **Ritmo ligero**: `sampleLight` cada **3 s** mientras la cápsula es visible (`compact`, `peek`, panel abierto).
  - **Ritmo completo**: `sampleFull` + `top` cada **1 s** solo mientras la vista "Sistema" está abierta.
  - **Pausa**: sin muestras en `mini`, `hidden` y mientras la cápsula muestra una alerta que tapa las métricas.
  - Emite `system:metrics` (ligera o completa) al notch.
- **Cerrar un proceso** (`system:kill-process { pid, startTime }`): main exige que el `pid` esté en la **última lista enviada**, vuelve a abrir el proceso, comprueba que su `startTime` coincide (PID no reutilizado) y que sigue siendo `killable`, y llama a `TerminateProcess`. Resultado: `killed` | `gone` | `denied` | `not-killable`.

### IPC

| Canal / evento | Entrada | Salida | Quién |
|---|---|---|---|
| evento `system:metrics` | — | `{ kind: 'light' \| 'full', ... }` | main → notch |
| `system:view` | `{ open: boolean, by?: 'cpu' \| 'ram' }` | `null` | **solo notch** (activa/desactiva el ritmo completo y el orden) |
| evento `system:processes` | — | `ProcessRow[]` | main → notch, cada 1 s con la vista abierta |
| `system:kill-process` | `{ pid: int, startTime: string }` | `'killed' \| 'gone' \| 'denied' \| 'not-killable'` | **solo notch** |

Todo pasa por `registerIpc` (comprobación de sender, zod de entrada y salida). El renderer nunca envía un nombre de proceso ni una ruta.

### Notch

- **Estado y geometría**: integración `system` en `src/shared/integrations/registry.ts`, vista y modo `system` (panel de **520×280**), en `PANEL_MODES`.
- **Cápsula compacta** (`compact`): `hora · fecha · CPU · RAM · batería` con iconos Lucide (`Cpu`, `MemoryStick`, `Battery` / `BatteryCharging` / `BatteryLow` sin color de alarma), cifras en Grafito Cristal, tabulares. `CAPSULE_SIZES.compact` crece al ancho que quepa en ES y EN (estimado ~300 px; se fija con capturas). Sin batería no se reserva hueco. Sin datos todavía: "—".
- **Vista "Sistema"** (`src/renderer/notch/system/`):
  - Cabecera: `←` y "Sistema".
  - Tarjetas: CPU % con sparkline de 60 s, RAM usada/total con sparkline, red ↑/↓, batería (% · cargando · tiempo restante). Sparklines en SVG `polyline` sin animación.
  - Discos: una línea por unidad fija (`C: 62 % · 120 GB libres · actividad 3 %`).
  - Procesos: `Segmented` `CPU | RAM`; 5 filas (nombre, CPU %, RAM); **Cerrar** visible con hover o foco solo si `killable`.
  - Confirmación en línea: la fila pasa a "¿Cerrar chrome.exe (PID 1234)? `Cancelar` `Cerrar`", foco en Cancelar. Resultados: `killed` → la fila desaparece en el siguiente refresco; `denied` → "Sin permiso"; `gone` → "Ya no existe"; `not-killable` → "No se puede cerrar".
  - Teclado completo; Esc cancela la confirmación y, sin confirmación, vuelve a la fila de integraciones.
- i18n ES/EN; tokens de `DESIGN.md`; `prefers-reduced-motion` respetado.

## Seguridad

1. El cierre de procesos solo lo puede pedir la ventana del notch, solo sobre PIDs de la última lista que main envió, con `startTime` coincidente.
2. Nunca se cierran procesos de otros usuarios, del sistema, críticos (`IsProcessCritical`), de otra sesión, el propio notch ni sus hijos.
3. La confirmación es obligatoria en la UI; main no confía en ella y revalida todo.
4. El log no registra nombres de procesos ni PIDs de terceros; solo resultados y fallos de API.

## Coste

- En reposo con la cápsula visible: una `sampleLight` cada 3 s (tres llamadas Win32). Objetivo: CPU de la app ≈ 0 % medida durante 1 min; RAM sin crecimiento sostenido.
- Con la vista abierta: `sampleFull` + procesos cada 1 s; aceptable mientras está abierta (como la terminal).

## Errores

- koffi o una DLL no cargan: el monitor se desactiva, la cápsula muestra hora y fecha como antes y la vista dice "Monitor no disponible".
- Una métrica falla: "—" en esa métrica, el resto sigue.
- `OpenProcess` denegado al listar: la fila aparece sin CPU/RAM ("—") y no es `killable`.

## Pruebas

- **Unitarias** con `SystemApi` falsa: CPU por diferencias (multi-núcleo, primera muestra nula, contadores que no avanzan); RAM; batería con y sin batería y cargando; discos (solo fijas); red (suma de interfaces, PDH ausente → null); top-5 por CPU y por RAM; `killable` (otro usuario, crítico, otra sesión, el notch, hijo del notch); validación de cierre (PID fuera de la lista, `startTime` distinto → `gone`, acceso denegado → `denied`); ritmos 3 s / 1 s / pausa en `mini`, `hidden` y alerta; geometría del modo `system` y de la cápsula compacta nueva; contratos IPC y guards.
- **E2E**: el test lanza un proceso propio (`node -e "setInterval(()=>{},1e3)"`), abre la vista, lo encuentra, lo cierra con confirmación y comprueba que muere; cifras visibles en la cápsula; capturas ES/EN de la cápsula y de la vista.
- **Medición**: CPU de la app en reposo con la cápsula visible durante 1 min (Administrador de tareas / `process.getCPUUsage`).

## Criterios de aceptación

1. La cápsula muestra hora, fecha, CPU %, RAM % y batería % (si hay batería), actualizados cada ~3 s, sin truncar en ES ni EN.
2. La vista "Sistema" muestra CPU, RAM, red, batería, discos y los 5 procesos que más consumen, actualizados cada ~1 s.
3. Cerrar un proceso propio pide confirmación y lo termina; nunca ofrece cerrar procesos del sistema, de otros usuarios ni el propio notch.
4. Con la app en reposo y la cápsula visible, la CPU de la app sigue ≈ 0 %.
5. Con la cápsula en `mini` u oculta no se toma ninguna muestra.

## Fuera de alcance (de este hito)

Avisos y umbrales (hito 2); batería de dispositivos Bluetooth (hito 3); GPU y temperaturas; historial más allá de 60 s; cerrar árboles de procesos; prioridad o afinidad de procesos.
