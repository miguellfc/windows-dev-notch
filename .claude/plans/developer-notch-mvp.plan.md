# Plan: Developer Notch — MVP (M0–M4)

**Source PRD**: `.claude/PRPs/prds/developer-notch.prd.md`
**Selected Milestone**: MVP completo, en orden M0 → M1 → M2 → M3 → M4 (siguiente pendiente: M0 · Spike técnico)
**Complexity**: Large

## Summary

Construir Developer Notch por hitos verificables: primero un spike desechable que confirma las suposiciones de las que depende el diseño (M0), luego la base de la cápsula (M1) y encima tres módulos independientes: Quick Launcher (M2), estado de Claude Code (M3) y recordatorios (M4). Cada hito termina con la app ejecutada, capturas de todos sus estados y los criterios de aceptación del PRD cumplidos. Las fases 2–4 del producto quedan a alto nivel y se replanifican tras validar la hipótesis.

## Patterns to Mirror

El repositorio no tiene código todavía (solo README, PRD, PRODUCT.md y DESIGN.md). No hay patrones existentes que imitar; el paso 1.1 los establece y los siguientes pasos los siguen.

| Category | Source | Pattern |
|---|---|---|
| Naming | — (se fija en 1.1) | Archivos kebab-case, componentes React PascalCase, canales IPC `dominio:accion` |
| Errors | — (se fija en 1.3) | Los handlers IPC devuelven `Result` tipado `{ ok, data } \| { ok: false, error: { code, message } }`; nunca lanzan al renderer |
| Logging | — (se fija en 1.2) | Logger del main con niveles y archivo rotativo en `%APPDATA%/Developer Notch/logs` |
| Data access | — (se fija en 1.4) | Solo `SettingsStore` toca disco en el MVP; validación zod en lectura y escritura |
| Tests | — (se fija en 1.1) | Vitest en `tests/unit/**`, Playwright `_electron` en `tests/e2e/**` con screenshots |
| Visual | `DESIGN.md`, `PRODUCT.md` | Tokens Obsidian, reglas con nombre, principios de producto |

## Orden y dependencias

```
M0 Spike ──► M1 Foundation ──► M2 Quick Launcher ──► M3 Claude Code ──► M4 Recordatorios
                                 (M2, M3 y M4 solo dependen de M1; orden recomendado para un solo dev)
```

- M0 es una puerta: si alguna duda sale mal, se ajusta el diseño antes de M1.
- M2 va primero porque da valor diario sin dependencias externas.
- M3 depende además de los payloads reales capturados en M0.
- M4 reutiliza la alerta y el toast que construye M3.

## Tasks

### M0 · Spike técnico (código desechable en `spikes/m0/`, no se reutiliza) — Complejidad: S

#### Task 0.1: App Electron mínima de prueba
- **Action**: Proyecto Electron + TS mínimo en `spikes/m0/` (sin React ni Tailwind), una ventana frameless transparente always-on-top.
- **Validate**: arranca con `npm start` dentro de `spikes/m0/`.

#### Task 0.2: Ventana adaptable, morph y clicks
- **Action**: Cápsula HTML que alterna compacta ↔ expandida; la ventana se redimensiona de golpe y el contenido anima con CSS; `setIgnoreMouseEvents(true, { forward: true })` solo durante la transición.
- **Validate**: checklist manual con capturas a 100/125/150 %: sin parpadeo visible; los clicks fuera de la cápsula llegan a la app de debajo en todos los estados; la sombra no queda recortada.

#### Task 0.3: Detección de maximizado y pantalla completa con koffi
- **Action**: Sondeo cada 500 ms de `SHQueryUserNotificationState`, `GetForegroundWindow` + `IsZoomed` + `MonitorFromWindow`; registrar cambios en consola.
- **Validate**: log correcto con navegador maximizado, YouTube a pantalla completa, PowerPoint en presentación y juego en fullscreen; coste de CPU del sondeo ≈ 0 %.

#### Task 0.4: Hooks de Claude Code desde la app de escritorio
- **Action**: Servidor HTTP en `127.0.0.1` que registra cada POST. Añadir **a mano y con backup** hooks `http` (`UserPromptSubmit`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`) en `~/.claude/settings.json`; trabajar con una sesión real en la app de escritorio Claude, incluyendo una petición de permiso.
- **Validate**: payloads reales guardados como fixtures en `spikes/m0/fixtures/` (sin datos sensibles); latencia evento → servidor medida; se restaura `settings.json` desde el backup al terminar.

#### Task 0.5: Foco, atajo global y traer la app Claude al frente
- **Action**: `globalShortcut` muestra la cápsula y toma el foco desde otra app; Esc oculta y el foco vuelve; probar traer la ventana de la app Claude al frente (EnumWindows/SetForegroundWindow vía koffi o protocolo `claude://`).
- **Validate**: funciona desde IDE, navegador y terminal; se documenta qué método trae la app Claude al frente de forma fiable (o que no lo hay).

#### Task 0.6: Multi-monitor con DPI mixto
- **Action**: Posicionar la cápsula en el monitor del cursor con `getDisplayNearestPoint`; reposicionar en `display-metrics-changed`.
- **Validate**: posición y nitidez correctas al mover el cursor entre monitores con escalas distintas y al conectar/desconectar uno.

#### Task 0.7: Informe de hallazgos y decisión
- **Action**: `docs/spikes/m0-findings.md` con resultado de cada prueba, evidencia (capturas/logs), plan B donde haga falta y preguntas abiertas del PRD resueltas o reformuladas.
- **Validate**: revisión contigo; el diseño se confirma o se ajusta antes de empezar M1.

### M1 · Foundation — Complejidad: L

#### Task 1.1: Scaffold del proyecto
- **Action**: electron-vite (React + TS), TypeScript estricto, Tailwind, Motion, Zustand, zod, lucide-react, Vitest, Playwright; estructura de carpetas aprobada (`src/main`, `src/preload`, `src/renderer/{notch,control-center}`, `src/shared`, `tests/{unit,e2e}`); scripts `dev`, `build`, `typecheck`, `test`, `test:e2e`, `lint`.
- **Mirror**: estructura de carpetas aprobada en el brainstorming.
- **Validate**: `npm run typecheck && npm test && npm run build`.

#### Task 1.2: Base de seguridad y ciclo de vida
- **Action**: Fábrica de `BrowserWindow` con `contextIsolation`, `sandbox`, `nodeIntegration: false`; CSP estricta sin `unsafe-eval`; bloqueo de `will-navigate` y `setWindowOpenHandler`; instancia única; logger con archivo rotativo; ocultar en vez de cerrar.
- **Validate**: tests unitarios de la fábrica; segunda instancia enfoca la existente.

#### Task 1.3: Contrato IPC tipado
- **Action**: `src/shared/ipc/contract.ts` (canales + esquemas zod de entrada/salida), `src/main/ipc/register.ts` (valida payload y remitente), `src/preload/index.ts` que expone `window.notch` generado desde el contrato; patrón `Result` para errores.
- **Validate**: tests que rechazan payloads inválidos, canales desconocidos y remitentes no esperados.

#### Task 1.4: SettingsStore
- **Action**: Esquema versionado de `settings.json` en `%APPDATA%`, valores por defecto, escritura atómica (temp + rename), migraciones, recuperación ante archivo corrupto (backup + defaults).
- **Validate**: tests de lectura, escritura, migración y corrupción.

#### Task 1.5: i18n ES/EN
- **Action**: Diccionarios tipados ES/EN en `src/shared/i18n/` con función `t()` y claves comprobadas por TypeScript; formateo de fechas y horas con `Intl`; idioma en settings. Sin librería externa salvo que M1 demuestre que hace falta.
- **Validate**: test que falla si una clave falta en algún idioma.

#### Task 1.6: Tokens y primitivas visuales
- **Action**: `tokens.css` con los valores de DESIGN.md → tema de Tailwind; Geist y Geist Mono empaquetadas; primitivas `Surface`, `StatusDot`, `Kbd`, `Tile`, `IconButton`; anillo de foco global.
- **Validate**: página de primitivas en dev con captura; contraste ≥ 4.5:1 comprobado.

#### Task 1.7: Máquina de estados de la cápsula y morph
- **Action**: Máquina pura `compact / peek / alert / expanded / mini / hidden` con transiciones permitidas; `NotchShell` con Motion (spring ~380/32, cierre ~180 ms, solo transform/opacity/clip-path); reduced-motion = fundidos.
- **Validate**: tests de transiciones; capturas de cada estado.

#### Task 1.8: WindowManager
- **Action**: Bounds por estado (incluido margen de sombra), monitor del cursor, DIP/DPI, eventos de pantallas, orden ventana ↔ animación validado en M0, `setIgnoreMouseEvents` solo en transiciones.
- **Validate**: tests de cálculo de posición; prueba manual multi-monitor.

#### Task 1.9: ForegroundWatcher
- **Action**: Versión de producción de M0.3 → estados `mini` / `hidden`; si koffi falla, modo manual y aviso en el Control Center.
- **Validate**: tests con la capa Win32 simulada; prueba manual maximizado/fullscreen/presentación.

#### Task 1.10: Integración con Windows
- **Action**: Tray (mostrar/ocultar, Control Center, inicio con Windows, salir), atajo global configurable con detección de conflicto, `setLoginItemSettings`, AppUserModelId para toasts.
- **Validate**: prueba manual de cada opción; conflicto de atajo simulado.

#### Task 1.11: Control Center (esqueleto)
- **Action**: Ventana con Mica, navegación lateral y páginas Apariencia, Idioma, Atajo e Inicio con Windows, conectadas a settings.
- **Validate**: cambios persistidos y aplicados en vivo.

#### Task 1.12: Empaquetado NSIS
- **Action**: electron-builder NSIS, `asarUnpack` para koffi, iconos.
- **Validate**: instalar, arrancar con Windows, desinstalar limpio.

#### Task 1.13: QA visual y criterios 1–10
- **Action**: E2E Playwright que recorre estados y captura a 100/125/150 %; medición de CPU/RAM en reposo; brief de superficie de la cápsula con `/impeccable` y refresco de DESIGN.md con `/impeccable document`.
- **Validate**: criterios de aceptación 1–10 del PRD con evidencia.

### M2 · Quick Launcher — Complejidad: M

#### Task 2.1: Modelo de favoritos
- **Action**: Esquema zod de los 5 tipos (app, carpeta, proyecto, URL, comando con argv fijo y cwd) y migración de settings.
- **Validate**: tests de esquema.

#### Task 2.2: LauncherService por ID
- **Action**: `launcher:open({ id })` → `shell.openPath` / `shell.openExternal` (solo http/https) / `execFile` sin shell; errores tipados (no existe, falla al abrir).
- **Validate**: tests con `shell` y `child_process` simulados; prueba de que no acepta rutas ni comandos desde el renderer.

#### Task 2.3: CRUD en el Control Center
- **Action**: Lista, crear, editar, reordenar y borrar, con validación en formulario y selectores de archivo/carpeta desde el main.
- **Validate**: E2E del CRUD.

#### Task 2.4: Buscador y cuadrícula en el panel
- **Action**: Búsqueda filtrada, navegación por flechas, Enter abre, error claro en favorito roto, la cápsula se contrae tras abrir.
- **Validate**: E2E teclado completo; tiempo atajo → apertura < 2 s.

#### Task 2.5: QA y criterios 11–14
- **Validate**: criterios 11–14 con evidencia y capturas.

### M3 · Estado de Claude Code — Complejidad: L

#### Task 3.1: AgentProvider y AgentHub
- **Action**: Interfaz `AgentProvider` (estado de conexión, sesiones, acciones) y modelo `AgentSession` en `src/shared`; AgentHub en el main.
- **Validate**: tests con un proveedor falso.

#### Task 3.2: ClaudeBridge
- **Action**: Servidor HTTP solo en `127.0.0.1`, puerto configurable, token, límite de tamaño, esquemas zod tolerantes construidos desde los fixtures de M0.
- **Validate**: tests con fixtures; rechaza sin token, payload grande o inválido.

#### Task 3.3: SessionRegistry
- **Action**: Estados trabajando / esperando / terminada / error / inactiva desde los eventos; inactiva tras 30 min sin eventos; descartar sesión.
- **Validate**: tests con secuencias de fixtures y relojes falsos.

#### Task 3.4: HookInstaller
- **Action**: Leer `~/.claude/settings.json`, fusionar hooks marcados como propios, generar diff, backup, escritura atómica, desinstalación que restaura el estado previo; instalación idempotente.
- **Validate**: tests exhaustivos (conserva hooks existentes, idempotente, desinstalación exacta, archivo ausente o corrupto).

#### Task 3.5: Página Integraciones en el Control Center
- **Action**: Estado de conexión, instalar/desinstalar con diff visible, probar conexión, rotar token.
- **Validate**: E2E con `settings.json` temporal.

#### Task 3.6: UI de sesiones y alertas
- **Action**: Indicador agregado en la cápsula, tarjeta en el panel, alerta `alert` con pulso, toast nativo si está oculta, click trae la app Claude al frente con el método validado en M0, estado "no conectado".
- **Validate**: E2E con POSTs simulados; prueba real con la app Claude; latencia < 1 s.

#### Task 3.7: QA y criterios 15–20
- **Validate**: criterios 15–20 con evidencia.

### M4 · Recordatorios — Complejidad: M

#### Task 4.1: Modelo y parser rápido
- **Action**: Esquema de recordatorio y parser ES/EN ("en 30 min" / "in 30 min", "16:00", "cada día" / "daily").
- **Validate**: tests de parser en ambos idiomas, incluidos casos ambiguos.

#### Task 4.2: Planificador
- **Action**: Timers en el main, re-programación en `powerMonitor` `resume`, recordatorios perdidos al arrancar, posponer y completar.
- **Validate**: tests con relojes falsos; prueba manual de suspensión.

#### Task 4.3: Integración en la UI
- **Action**: Detectar intención de recordatorio en el buscador, alerta en la cápsula con acciones, toast con acciones, lista en el Control Center.
- **Validate**: E2E crear → disparar → posponer/completar.

#### Task 4.4: QA y criterios 21–24
- **Validate**: criterios 21–24 con evidencia; arranca el periodo de 2 semanas de medición de la hipótesis.

### Fases posteriores (alto nivel; se replanifican tras validar la hipótesis)
- **Fase 2 · Productivity**: centro de notificaciones con SQLite, Developer Toolbox, ajustes avanzados, indexado del Menú Inicio y repos.
- **Fase 3 · Intelligence**: Meetings con Google Calendar/Gmail (OAuth + `safeStorage`), más proveedores de agentes, aprobar permisos desde la cápsula si se valida.
- **Fase 4 · Advanced**: System Monitor, automatizaciones, n8n, personalización avanzada, firma de código y auto-update.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Además, en cada hito: ejecutar la app, capturar todos los estados a 100/125/150 % y revisar alineación, tipografía, espaciado y animaciones contra DESIGN.md.

## Risks

| Risk | Step | Likelihood | Mitigation |
|---|---|---|---|
| La app de escritorio Claude no dispara los hooks de usuario | 0.4 | M | Plan B: `claude agents --json` + soporte CLI; replantear M3 antes de M1 |
| No hay forma fiable de traer la app Claude al frente | 0.5, 3.6 | M | Mostrar la sesión en el panel y abrir la app sin foco forzado; documentar la limitación |
| Clicks bloqueados o parpadeo en la ventana transparente | 0.2, 1.8 | M | Enfoque A validado en M0; si falla, reconsiderar antes de M1 |
| DPI mixto en multi-monitor | 0.6, 1.8 | M | Posición en DIP y reposicionar en eventos de pantalla; prueba en monitores reales |
| koffi no carga en el build empaquetado | 0.3, 1.9, 1.12 | L | `asarUnpack`; modo manual sin auto mini/hidden |
| Foreground lock impide tomar o devolver el foco | 0.5, 1.10 | M | Atajo global; ocultar en vez de desenfocar |
| Atajo global ocupado | 1.10 | L | Detección y aviso con alternativa |
| Romper el `settings.json` de Claude del usuario | 0.4, 3.4 | L | Backup siempre, marca propia, tests exhaustivos, desinstalación exacta |
| Formato de hooks cambia entre versiones de Claude Code | 3.2 | M | zod tolerante y estado "desconectado" |
| Sesiones fantasma sin `SessionEnd` | 3.3 | H | Inactiva a los 30 min y descartar manual |
| Bridge accesible por otros procesos locales | 3.2 | L | `127.0.0.1`, token, límite de tamaño |
| Textos ES/EN rompen layouts compactos | 1.5, 1.7, 2.4 | M | Truncado con elipsis y QA en ambos idiomas |
| Recordatorios perdidos tras suspensión | 4.2 | M | Re-programar en `resume` y mostrar perdidos al arrancar |
| Consumo de recursos en reposo | 1.13 | M | Sin bucles de animación en reposo; medir en cada hito |
| SmartScreen avisa en el instalador sin firmar | 1.12 | H | Aceptado para uso personal |
| Alcance creciente (meter fases 2–4 antes de validar) | Todos | M | No empezar fases 2–4 hasta completar las 2 semanas de medición |

## Acceptance
- [ ] M0: hallazgos documentados y diseño confirmado o ajustado
- [ ] M1–M4: criterios 1–24 del PRD cumplidos con evidencia (tests + capturas)
- [ ] Validación (`typecheck`, `lint`, `test`, `test:e2e`, `build`) en verde en cada hito
- [ ] DESIGN.md refrescado desde el código tras M1
- [ ] Patrones fijados en 1.1–1.4 seguidos en el resto, no reinventados
