# Developer Notch for Windows

## Problem Statement

Un desarrollador en Windows que trabaja en 3 o más proyectos a la vez, cada uno con su propia sesión de Claude Code en la app de escritorio, pierde tiempo cambiando de aplicación para acciones rápidas (abrir un proyecto, una URL, comprobar si Claude terminó) y se le olvidan cosas porque nada le avisa a tiempo. El coste es doble: sesiones de Claude paradas esperando permiso sin que nadie se entere, y tareas o compromisos que se pasan por alto.

## Evidence

- Usuario: "En ocasiones llevo más de 3 proyectos y a consecuencia más de una sesión de Claude Code."
- Usuario: "Muchas veces pierdo tiempo yendo a una aplicación X pudiendo resolverlo desde un notch."
- Usuario: "Muchas veces se me olvidan ciertas cosas porque no tengo quien me avise o recuerde."
- Usuario: "No he encontrado ninguna aplicación que resuelva todos mis problemas."
- Mercado: en macOS existen varias apps de notch para supervisar sesiones de Claude Code (Claude Visor, Claude Island, AgentPeek, Notchy, Vibe Island), lo que indica que el problema es real y compartido. En Windows, las apps tipo Dynamic Island encontradas (Notchify, Isle Notch, DynamicWin, Smart Notch) se centran en multimedia, portapapeles y toasts, sin integración con agentes de IA.
- Assumption - el tiempo perdido y la frecuencia de olvidos no están cuantificados; se validará con las métricas de éxito tras 2 semanas de uso.

## Proposed Solution

Una cápsula flotante, discreta y siempre disponible en la parte superior central de la pantalla (estilo Dynamic Island), construida con Electron + React + TypeScript. En reposo muestra hora, estado agregado de las sesiones de Claude Code y avisos pendientes; con un click o un atajo global se expande a un panel con favoritos buscables por teclado, las sesiones de Claude y los recordatorios. Se elige este enfoque frente a un launcher (ya maduros en Windows: PowerToys Command Palette, Flow Launcher) porque el valor diferencial está en **combinar estado en vivo + acción rápida en un único punto que no roba foco**, algo que ninguna herramienta de Windows ofrece hoy para desarrolladores.

## Key Hypothesis

Creemos que una cápsula que muestra el estado de todas mis sesiones de Claude Code, me recuerda lo pendiente y me da acceso por teclado a mis favoritos reducirá el tiempo perdido cambiando de aplicación y los olvidos para un desarrollador que lleva varios proyectos en paralelo en Windows.
Sabremos que acertamos cuando, tras 2 semanas de uso diario: (a) ya no compruebo a mano la app Claude para ver si una sesión espera, (b) abro mis proyectos/URLs habituales desde la cápsula y no desde el Menú Inicio o la barra de tareas, y (c) la app sigue abierta todo el día sin que la cierre por molesta.

## What We're NOT Building

- Multiplataforma (macOS/Linux) - solo Windows 11 por ahora.
- Launcher universal (indexar todo el PC, Menú Inicio, archivos) - PowerToys/Flow Launcher ya lo resuelven; aquí solo favoritos curados en el MVP.
- Chat con Claude desde la cápsula - duplica la app Claude y amplía mucho el alcance. (La terminal embebida ya NO está aquí: entró en alcance con el cambio de dirección de 2026-11-09 y está hecha en M2.)
- ~~Aprobar/denegar permisos de Claude desde la cápsula~~ - ya NO está excluido: se decidió el 2026-11-10 y está hecho en M3 (solo "permitir una vez" o "denegar", solo con click).
- Multimedia, portapapeles, widgets decorativos - no resuelven el problema planteado.
- Sincronización en la nube, cuentas, multiusuario - herramienta personal.
- Firma de código y auto-update - innecesario mientras sea de uso personal.

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| Uso diario sostenido | App abierta todo el día ≥ 9 de 10 días laborables durante 2 semanas | Log local de arranque/cierre y autoevaluación |
| Comprobaciones manuales de la app Claude | ≈ 0 por día ("ya no lo hago") | Autoevaluación al final de las 2 semanas |
| Latencia de aviso de Claude | < 1 s desde el evento del hook hasta la alerta en la cápsula | Timestamps en el log del bridge vs. renderer |
| Tiempo para abrir un favorito | < 2 s con teclado (atajo → escribir → Enter) | Medición manual/E2E |
| Favoritos abiertos desde la cápsula | ≥ 5 por día laborable | Contador local de aperturas |
| Recordatorios cumplidos | Ningún recordatorio perdido con la app en ejecución | Log de disparos de recordatorios |
| Consumo en reposo | CPU ≈ 0 %; RAM total < 200 MB sin integraciones abiertas (la terminal abierta añade ~100 MB, aceptado) | Administrador de tareas |

## Open Questions

- [x] ¿Las sesiones de la app de escritorio Claude disparan los hooks de `~/.claude/settings.json` de forma fiable? **Sí** (M0; en M3 también `PermissionRequest` y `Notification`, en caliente y sin reiniciar Claude)
- [ ] ¿Qué campos trae exactamente `StopFailure` en su stdin/body? (no verificado en la documentación)
- [ ] ¿Se puede enfocar la sesión exacta en la app Claude y no solo la app? (no hay deep link documentado por ID de sesión)
- [x] ¿Cómo se comporta `setIgnoreMouseEvents` + redimensionado de ventana transparente en Windows 11? **Bien**: ventana transparente y click-through funcionan (M0, confirmado por el usuario). **Sigue abierto: DPI mixto / multi-monitor** (solo se probó un monitor al 100 %)
- [ ] ¿Detección de compartir pantalla? Solo existe la de modo presentación; ¿basta el atajo manual?
- [x] ¿Aprobar permisos de Claude desde la cápsula aporta lo suficiente para justificar su riesgo? Decidido el 2026-11-10 y hecho en M3 con diseño de seguridad propio; su valor real se evalúa en la validación de 2 semanas

---

## Users & Context

**Primary User**
- **Who**: El propio autor. Desarrollador en Windows 11 que lleva 3 o más proyectos activos en paralelo, cada uno con su sesión de Claude Code en la app de escritorio Claude. Posiblemente, en el futuro, algún compañero de trabajo con el mismo perfil.
- **Current behavior**: Alterna manualmente entre la app Claude, el IDE, el navegador, el explorador y la terminal; revisa la app Claude para ver si alguna sesión espera; confía en la memoria para lo pendiente.
- **Trigger**: Una sesión de Claude se queda esperando permiso o input sin que se entere; necesita abrir rápidamente un proyecto/URL/herramienta; algo pendiente se le olvida.
- **Success state**: Un vistazo a la cápsula le dice qué necesita su atención ahora y actúa desde ahí sin cambiar de app.

**Job to Be Done**
Cuando trabajo en varios proyectos con varias sesiones de Claude a la vez, quiero ver de un vistazo qué necesita mi atención y actuar al momento, para no perder tiempo cambiando de app ni olvidar cosas.

**Non-Users**
- Usuarios de macOS o Linux (solo Windows por ahora).
- Quien busque un launcher universal o un reemplazo de la búsqueda de Windows.
- Quien quiera una isla decorativa o de multimedia.
- Equipos que necesiten gestión centralizada o despliegue corporativo.
- Usuarios de Claude Code solo por CLI o IDE: probablemente funciona (mismos hooks), pero no es prioritario.

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|----------|------------|-----------|
| Must | Cápsula compacta always-on-top, centrada arriba, con estados compact / peek / alert / expanded / mini / hidden | Es el producto; debe estar siempre disponible sin estorbar |
| Must | Expansión por click o atajo global; Esc / click fuera cierra; teclado primero | Acción en < 2 s sin ratón |
| Must | Auto `mini` con ventana maximizada debajo y `hidden` en pantalla completa / presentación | Principal queja de las islas en Windows: tapan contenido |
| Must | Multi-monitor (sigue al cursor) y escalado DPI correcto | Uso real con varios monitores |
| Must | System tray, ocultar sin cerrar, inicio con Windows | Integración nativa básica |
| Must (sustituido) | Quick Launcher con favoritos manuales (app, carpeta, proyecto, URL, comando de lista blanca) | Aparcado en la rama `feat/m2-quick-launcher` (sin mergear); sustituido por integraciones vivas + terminal PowerShell (ver "Cambio de dirección") |
| Must | Estado en vivo de sesiones de Claude Code (trabajando / esperando / terminada / error / inactiva) con alerta y toast nativo | Resuelve "no me entero de que Claude me espera" |
| Must | Instalación de hooks de Claude Code desde la app con diff, backup, fusión y desinstalación | Integración segura con la configuración del usuario |
| Must (hecho en M4) | Recordatorios locales rápidos (relativos, a una hora, repetición diaria) con alerta en cápsula + toast | Resuelve "se me olvidan cosas"; implementado como integración del notch (ver "M4: cambios respecto al PRD original") |
| Must | Control Center: favoritos, atajos, apariencia, integraciones, recordatorios | Configuración sin editar archivos |
| Should | Indicador de reuniones próximas (Google Calendar) | Fase 3; requiere OAuth |
| Should | Centro de notificaciones con historial (SQLite) y prioridades | Fase 2 |
| Should | Developer Toolbox | Fase 2; alcance por definir |
| Must (M3, decidido 2026-11-10, hecho) | Aprobar / denegar permisos de Claude desde la alerta (hook `PermissionRequest`): solo "permitir una vez" o "denegar", solo con click | Diseño de seguridad en `docs/superpowers/specs/2026-11-10-m3-claude-status-design.md` |
| Could | Indexado del Menú Inicio y detección automática de repos | Comodidad; no esencial con favoritos |
| Could (núcleo hecho tras el MVP) | System Monitor (CPU, RAM, batería, disco, red) | Era Fase 4; el núcleo está hecho en `feat/system-monitor` (ver "System Monitor (núcleo)"); avisos por umbral hechos en `feat/system-alerts`; batería Bluetooth pendiente |
| Could (hecho tras el MVP) | Notas rápidas en el notch (lista con buscar, copiar, editar, fijar y borrar con Deshacer) | Integración viva más tras el cambio de dirección; hecha en `feat/notes` (ver "Notas rápidas — hecho tras el MVP") |
| Could (hito 1 hecho tras el MVP) | Gmail en el notch: sin leer de Principal en la cápsula y los 5 más recientes | Hito 1 (base, solo lectura) hecho en `feat/gmail`; hitos 2 (leer y actuar) y 3 (avisos) hechos en `feat/gmail-actions` (ver "Gmail — hitos 2 y 3"); falta la comprobación manual del usuario |
| Could (hecho tras el MVP) | Responder desde el notch las preguntas de Claude Code (`AskUserQuestion`): aviso, tarjeta con opciones y "Otro", teclado | Hecho en `feat/claude-questions` (ver "Preguntas de Claude — hecho"); falta la comprobación manual del usuario |
| Could (hito 1 hecho) | GitHub y GitLab en el notch: PR/MR tuyos sin revisar en la cápsula, aviso de primera revisión y vista "Revisiones" | Hito 1 hecho en `feat/code-review` (ver "GitHub y GitLab — hito 1 hecho"); falta la comprobación manual con tokens reales; hito 2 (contribuciones) pendiente |
| Could | Otros proveedores de agentes (Codex, Gemini CLI…) | La arquitectura `AgentProvider` lo permite |
| Won't | Multiplataforma, launcher universal, chat embebido, sync en la nube | Ver "What We're NOT Building" |

### MVP Scope

M0 spike técnico + M1 Foundation + M2 (redirigido a Integraciones + terminal PowerShell; el Quick Launcher de favoritos está aparcado) + M3 estado de Claude Code y permisos desde el notch + M4 recordatorios locales. Es lo mínimo para probar la hipótesis: estado en vivo de agentes, acción rápida y avisos de lo pendiente, en una cápsula que no estorba.

**Estado (2026-11-10): MVP terminado.** M0-M4 están mergeados en `dev` (merges `65e1ba3` M0, `32bdb9f` M1, `8a8b5f7` M2, `1753fbb` M3, `92b0c4c` M4; PRs #2-#6 de miguellfc/windows-dev-notch). Falta la validación de 2 semanas (ver "Validación (2 semanas)").

### User Flow

1. Arranque con Windows → cápsula compacta arriba al centro (hora · estado Claude · badge).
2. Una sesión de Claude pide permiso → la cápsula pasa a `alert` ("Claude espera permiso · proyecto") ~4 s y queda con punto ámbar pulsando; si está oculta, toast nativo.
3. Click en la alerta o en la sesión → la app Claude pasa al frente.
4. `Ctrl+Alt+Space` desde cualquier app → panel expandido con foco en el buscador → escribe "web" → `Enter` → abre WebStorm con el proyecto → la cápsula se contrae.
5. En el buscador escribe un recordatorio ("en 30 min revisar PR") → a su hora, alerta en la cápsula + toast.

---

## Technical Approach

**Feasibility**: MEDIUM-HIGH. Electron cubre ventana transparente, always-on-top, tray, atajos, notificaciones e inicio con Windows; el patrón "hooks de Claude Code → servidor local → notch" ya funciona en apps de macOS. La incertidumbre principal (hooks desde la app de escritorio) se resuelve en M0.

**Architecture Notes**
- Stack: Electron, React, TypeScript, Vite (`electron-vite`), Tailwind CSS, Motion, Zustand, Vitest, Playwright (`_electron`), empaquetado con `electron-builder` (NSIS). Añadidos justificados: `zod` (validación), `lucide-react` (iconos), `koffi` (Win32 sin compilación). SQLite se incorpora en Fase 2, no en el MVP.
- Capas estrictas: main (servicios, privilegios) / preload (puerta única) / renderer (sandbox, solo UI) / shared (contratos y tipos sin Node ni DOM).
- Contrato IPC único en `src/shared/ipc/contract.ts` con esquemas zod de entrada/salida; el main valida cada mensaje y el remitente; el preload genera `window.notch.*` desde el contrato.
- Ventana de la cápsula de tamaño adaptable (enfoque A): crece de golpe al expandir, Motion anima el morph, se encoge tras contraer; `setIgnoreMouseEvents` solo en transiciones. Control Center es una ventana aparte con Mica.
- Lanzar por ID: el renderer solo envía `launcher.open({ id })`; el main resuelve el favorito guardado y usa `shell.openPath`, `shell.openExternal` (solo http/https) o `execFile` sin shell con argumentos fijos.
- `ForegroundWatcher` (koffi): `SHQueryUserNotificationState` para pantalla completa/presentación, `GetForegroundWindow` + `IsZoomed` para maximizado, sondeo ~500 ms.
- `AgentHub` + interfaz `AgentProvider`; `ClaudeCodeProvider` como primera implementación. `ClaudeBridge`: servidor HTTP solo en `127.0.0.1` con token, recibe hooks `http` de Claude Code (`UserPromptSubmit`, `Notification`, `Stop`, `StopFailure`, `SubagentStart/Stop`, `SessionEnd`). No se leen los transcripts `.jsonl` como API (formato interno).
- Persistencia MVP: `settings.json` en `%APPDATA%` validado con zod, escritura atómica y migraciones por versión (favoritos, atajos, apariencia, recordatorios).
- Recordatorios: planificador en el main con re-programación al reanudar (`powerMonitor` `resume`); los vencidos con la app cerrada se muestran como "perdidos" al arrancar.
- Seguridad: `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP estricta, navegación y `window.open` bloqueados, sin contenido remoto; futuras credenciales OAuth con `safeStorage`.
- Dirección visual "Obsidian": superficie casi opaca `rgba(14,14,16,.86)`, línea `rgba(255,255,255,.08)`, texto `#EDEDEF`/`#8B8B93`, acento `#7DD3FC`, estados ok `#4ADE80` / espera `#FBBF24` / error `#F87171`; Geist + Geist Mono empaquetadas; iconos Lucide; morph con spring (~380/32), salida más rápida que entrada (~180 ms), reduced-motion = solo fundidos. `backdrop-filter` no desenfoca el escritorio en ventanas transparentes, por eso la cápsula usa superficie casi opaca.

**Technical Risks**

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| La app de escritorio Claude no dispara los hooks de usuario | M | Validar en M0; plan B: `claude agents --json` para sesiones en segundo plano y soporte CLI; el módulo muestra "no conectado" |
| Clicks bloqueados por zonas transparentes (`forward` solo reenvía movimiento en Windows) | M | Enfoque A (ventana = cápsula); validar en M0 |
| Parpadeo al redimensionar ventana transparente; sin sombra nativa | M | Redimensionar de golpe y animar contenido; margen de sombra dentro de la ventana |
| Fallos de Electron con DPI mixto multi-monitor | M | Posicionar en DIP con `getDisplayNearestPoint`; reposicionar en `display-metrics-changed`; probar en monitores reales |
| Foreground lock de Windows impide tomar/devolver foco | M | El atajo global concede foco; ocultar en vez de solo desenfocar; validar en M0 |
| Atajo global ocupado por otra app | L | Comprobar el resultado de `register`, avisar y sugerir alternativa |
| Sesiones "fantasma" (cierre sin `SessionEnd`); "trabajando" se infiere | H | Marcar inactiva tras 30 min sin eventos; permitir descartar |
| Cambios de formato de hooks entre versiones de Claude Code | M | Validación zod tolerante; ante error, estado "desconectado" sin romper nada |
| Bridge local accesible por otros procesos locales | L | Solo `127.0.0.1`, token, límite de tamaño, zod; token rotable |
| Fallo de carga de `koffi` | L | Desempaquetar fuera de ASAR; sin él, modo manual (sin auto mini/hidden) |
| Detección de compartir pantalla no fiable | H | Solo modo presentación; atajo manual |
| Consumo de recursos de Electron | M | Sin bucles de animación en reposo; tick de reloj por minuto; pausar renderer oculto |
| SmartScreen avisa en instalador sin firmar | H | Aceptable para uso personal; firma en Fase 4 |
| Toasts / inicio con Windows dependen de AppUserModelId e instalación NSIS | L | Fijar AppUserModelId; inicio automático solo en NSIS |

---

## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: phases that can run concurrently (e.g., "with 3" or "-")
  DEPENDS: phases that must complete first (e.g., "1, 2" or "-")
  PRP: link to generated plan file once created
-->

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|-------|-------------|--------|----------|---------|----------|
| 1 | M0 · Spike técnico | Código desechable que resuelve las 4 incertidumbres críticas | complete | - | - | - |
| 2 | M1 · Foundation | Scaffold, contrato IPC, tokens, cápsula con todos los estados, ventanas, Windows integration, instalador | complete | - | 1 | - |
| 3 | M2 · Integraciones + terminal PowerShell | Fila de integraciones en el panel y terminal PowerShell real (`node-pty` + `xterm.js`). El launcher de favoritos (CRUD, búsqueda, lanzamiento por ID) queda aparcado en `feat/m2-quick-launcher` | complete | with 4, 5 | 2 | - |
| 4 | M3 · Claude Code status | Bridge, instalador de hooks, registro de sesiones, alertas, toast, aprobar/denegar permisos desde el notch | complete | with 3, 5 | 2 | - |
| 5 | M4 · Recordatorios | Recordatorios locales rápidos con alerta y toast | complete | with 3, 4 | 2 | - |
| 6 | Fase 2 · Productivity | Centro de notificaciones (SQLite), Developer Toolbox, ajustes avanzados, indexado Menú Inicio/repos | pending | - | 3, 4, 5 | - |
| 7 | Fase 3 · Intelligence | Meetings (Google Calendar/Gmail vía OAuth + `safeStorage`), más proveedores de agentes, aprobar permisos desde la cápsula (si se valida) | pending | - | 6 | - |
| 8 | Fase 4 · Advanced | System Monitor, automatizaciones, n8n, personalización avanzada, firma y auto-update | pending | - | 7 | - |

### Phase Details

**Phase 1: M0 · Spike técnico**
- **Goal**: Confirmar o descartar las suposiciones que podrían cambiar el diseño antes de construir.
- **Scope**: (a) ventana transparente adaptable con morph + `setIgnoreMouseEvents`, clicks bajo la cápsula; (b) `koffi` detectando maximizado y pantalla completa; (c) hooks `http` disparados desde una sesión de la app de escritorio Claude; (d) foco con atajo global y DPI mixto. Código etiquetado como desechable.
- **Success signal**: Las 4 dudas respondidas con evidencia (capturas/logs) o con plan B acordado.

**Phase 2: M1 · Foundation**
- **Goal**: Una cápsula que se pueda usar todo el día sin estorbar.
- **Scope**: Proyecto Electron + React + TS (electron-vite), contrato IPC, `settings.json` con zod, tokens Obsidian + Tailwind, máquina de estados de la cápsula, morph con Motion, WindowManager (monitor del cursor, DPI), ForegroundWatcher, tray, atajo global, inicio con Windows, Control Center (esqueleto), instalador NSIS, base de Vitest y Playwright.
- **Success signal**: Criterios de aceptación 1-10 cumplidos con screenshots de todos los estados.

**Phase 3: M2 · Quick Launcher (sustituido por Integraciones + terminal PowerShell; ver "Cambio de dirección")**
- **Goal** (original, aparcado): Abrir cualquier favorito en < 2 s solo con teclado.
- **Scope**: CRUD de favoritos (app, carpeta, proyecto, URL, comando) en Control Center, búsqueda filtrada, navegación por teclado, LauncherService por ID, gestión de favoritos rotos.
- **Success signal**: Criterios 11-14 cumplidos. (Sustituidos por los criterios 1-5 del nuevo M2; ver abajo.)

**Phase 4: M3 · Claude Code status**
- **Goal**: Enterarse al momento de cuándo una sesión de Claude necesita atención.
- **Scope**: ClaudeBridge, instalador/desinstalador de hooks con diff y backup, SessionRegistry con estados e inactividad, indicador en cápsula, tarjeta en panel, alerta + toast, enfocar app Claude, estado "no conectado".
- **Success signal**: Criterios 15-20 cumplidos.

**Phase 5: M4 · Recordatorios**
- **Goal**: Que nada pendiente se olvide mientras la app está en ejecución.
- **Scope**: Crear recordatorios desde el buscador de la cápsula y desde Control Center (relativo "en 30 min", hora "16:00", repetición diaria), planificador en el main con re-programación tras suspensión, alerta en cápsula + toast, posponer/completar, recordatorios perdidos mostrados al arrancar.
- **Success signal**: Criterios 21-24 cumplidos.

**Phase 6-8**: Se detallarán en su propio PRD/plan cuando el MVP esté validado.

### Parallelism Notes

M2, M3 y M4 solo dependen de M1 y tocan módulos distintos (`features/launcher`, `features/agents` + `main/agents`, `features/reminders`), por lo que podrían desarrollarse en paralelo. Como hay un solo desarrollador, el orden recomendado es M2 → M3 → M4: M2 da valor diario inmediato sin dependencias externas, y M3 se beneficia de que M0 haya validado los hooks. Las fases 6-8 son secuenciales y se replanifican tras validar la hipótesis.

### MVP Acceptance Criteria

Verificados en la máquina real con screenshots de cada estado, no solo compilando.

**Estado de verificación (2026-11-10):** M1 1-10 verificados en M1, con las salvedades indicadas. Criterios 11-14 del launcher original: no aplican (aparcado). Nuevo M2 1-5: verificados por E2E. M3 15-20: verificados (E2E + prueba manual con la app Claude, ver `docs/spikes/m3-hooks-findings.md`). M4 21 y 22 verificados en su forma actual (formulario del notch; toast sin botones — los botones del toast siguen sin verificar) y 24: por E2E y por la prueba manual del usuario ("Los recordatorios funcionan perfectamente"); 23: cubierto por tests unitarios y por la prueba del usuario. Pendiente de verificación manual: DPI mixto y multi-monitor, y los botones del toast.

**M1 · Foundation** — verificados (1-10), salvo lo indicado en 2
1. La app arranca en < 2 s; instancia única (un segundo arranque enfoca la existente).
2. La cápsula aparece arriba al centro del monitor correcto, nítida a 100/125/150 % y se reposiciona al conectar/desconectar monitores. *(Verificado solo con un monitor al 100 %; DPI mixto, 125/150 % y multi-monitor: pendiente de verificación manual.)*
3. Fuera de la cápsula visible, los clicks llegan siempre a la app de debajo, en todos los estados.
4. `compact → expanded → compact` anima sin parpadeos ni saltos, a 60 fps percibidos; con reduced-motion solo fundidos.
5. Con ventana maximizada debajo pasa a `mini`; con app a pantalla completa o modo presentación pasa a `hidden`; vuelve sola al salir.
6. El atajo global abre/cierra desde cualquier app; Esc o click fuera cierran; si el atajo está ocupado se avisa.
7. Tray: mostrar/ocultar, Control Center, inicio con Windows, salir; cerrar la ventana oculta la app, no la cierra.
8. En reposo: CPU ≈ 0 %, RAM total < 200 MB sin integraciones abiertas. *(Medido por el controlador en M1 con el Administrador de tareas, app empaquetada en reposo y sin integraciones abiertas, columna de memoria del grupo de procesos: CPU 0,02 %, RAM 124 MB; sin registro en el repo. El spike M2 (`docs/spikes/m2-pty-findings.md`) midió 183 MB privados / 354 MB de working set en desarrollo y sin sesión de terminal, así que la métrica a seguir es la memoria del Administrador de tareas de la app instalada.)*
9. El instalador NSIS instala, arranca con Windows si está activado y desinstala limpio. *(Probado por el usuario.)*
10. `contextIsolation`/`sandbox` activos, CSP sin `unsafe-eval`, todo IPC inválido se rechaza (probado con tests).

**M2 · Quick Launcher** — criterios originales aparcados con la rama `feat/m2-quick-launcher` (no aplican al MVP)
11. Crear, editar, reordenar y borrar favoritos de los 5 tipos en Control Center, con validación en el formulario.
12. `Ctrl+Alt+Space` → escribir → `Enter` abre el favorito en < 2 s sin ratón.
13. Un favorito roto muestra un error claro y no rompe nada.
14. Los comandos se ejecutan con argumentos fijos y sin shell; el renderer solo envía IDs (verificado con tests).

**M3 · Claude Code status** — verificados (15-20)
15. Instalar los hooks muestra diff, crea backup y conserva los hooks existentes; desinstalar deja `settings.json` como estaba.
16. Con una sesión en la app Claude, la cápsula refleja trabajando / esperando / terminado en < 1 s desde el evento.
17. "Claude espera permiso" dispara la alerta de la cápsula y, si está oculta, un toast nativo.
18. Click en una sesión pone la app Claude al frente.
19. Con la app Claude cerrada o sin hooks, el módulo muestra "no conectado" y el resto funciona.
20. Sesiones sin eventos durante 30 min pasan a "inactiva" y se pueden descartar.

**M4 · Recordatorios** — 21 y 22 verificados en su forma actual (formulario del notch; toast sin botones — los botones del toast siguen sin verificar), 24 verificado; 23 ver nota (la forma de crear y el toast cambiaron, ver "M4: cambios respecto al PRD original")
21. Crear un recordatorio desde el buscador ("en 30 min revisar PR", "16:00 standup") en < 5 s.
22. A su hora: alerta en la cápsula y toast nativo, con acciones posponer y completar.
23. Tras suspender/reanudar el PC, los recordatorios se re-programan correctamente. *(Cubierto por tests unitarios y probado por el usuario.)*
24. Los recordatorios vencidos con la app cerrada se muestran como "perdidos" al arrancar.

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Audiencia | Uso personal, quizá algún compañero | Equipo; producto público | Evita firma, auto-update y onboarding en el MVP |
| Alcance MVP | Base + launcher + Claude Code + recordatorios | Solo base; base + uno de ellos | Cubre los tres dolores del usuario |
| Interacción | Click + atajo global; hover solo feedback | Hover con retardo; solo atajo | Evita aperturas accidentales cerca de pestañas |
| Visibilidad | `mini` con maximizado, `hidden` en fullscreen | Siempre visible; ocultar manual | No tapar contenido (queja principal de las islas en Windows) |
| Multi-monitor | Sigue al cursor | Solo principal; monitor elegido | Uso real con varios monitores |
| Gestión de ventana | Ventana adaptable + morph (A) | Ventana grande fija con click-through (B); dos ventanas (C) | B arriesga franjas que bloquean clicks; C pierde la transición continua |
| Fuentes del launcher | Solo favoritos manuales | Menú Inicio; repos automáticos; comandos | Valor en favoritos curados; launchers universales ya existen |
| Instalación de hooks | La app los instala con diff, backup y desinstalación | El usuario los añade a mano | Comodidad sin perder control ni la configuración existente |
| Fuente de estado Claude | Hooks `http` → bridge local | Leer transcripts `.jsonl`; status line; OTel | Única vía documentada y en vivo; transcripts son formato interno |
| Dirección visual | Obsidian (negro neutro, acento azul hielo, Geist) | Terminal (pizarra + verde); Aurora glass (violeta) | Sobria, nativa, independiente del wallpaper |
| Persistencia MVP | JSON validado con zod | SQLite desde el inicio | Evitar módulo nativo hasta que haya historial (Fase 2) |
| Tooling | electron-vite + electron-builder | Electron Forge + Vite | Combinación estable y madura para este stack |
| Recordatorios | Adelantados al MVP como M4 | Dejar en Fase 2 | El usuario reporta olvidos frecuentes |
| Aprobar permisos de Claude | Post-MVP (Could) → **en el MVP como M3 (2026-11-10)** | Nunca | Alto valor; se resolvió con diseño de seguridad propio (solo "permitir una vez"/"denegar", solo click) |
| Toast de recordatorios (M4) | Sin botones; el click en el cuerpo abre la vista de recordatorios | Botones Posponer/Completar | No se pudo verificar el click en botones (ver `docs/spikes/m4-toast-findings.md`) |
| Plataforma | Solo Windows 11 | Multiplataforma | Foco y hueco de mercado en Windows |

---

## Research Summary

**Market Context**
- macOS: el concepto "notch para agentes de IA" está validado por varias apps (Claude Visor, Claude Island/Vibe Notch, AgentPeek, Notchy, Vibe Island). Patrones comunes: estado multi-sesión, aprobar permisos desde el notch, saltar a la sesión correcta. Claude Visor usa hooks de Claude Code que envían eventos a un socket local, el mismo patrón elegido aquí.
- Windows: existen islas (Notchify, Isle Notch, DynamicWin, Smart Notch, Dynamic Edge) centradas en multimedia, portapapeles, toasts, timers y to-dos; no se encontró ninguna orientada a desarrolladores ni con integración de agentes (una búsqueda por tema; no exhaustivo). Antipatrón reportado: la isla tapa contenido de otras apps.
- Launchers en Windows maduros (PowerToys Command Palette, Flow Launcher, Raycast beta): no competir en búsqueda universal.
- Fuentes: windowscentral.com (Notchify), toolradar.com (Isle Notch), github.com/FlorianButz/DynamicWin, alternativeto.net (Smart Notch, Claude Island, Flow Launcher), awesome.ecosyste.ms (claude-visor), producthunt.com (AgentPeek), everydev.ai (Notchy), vibeisland.app, dev.to (notch como centro de control de agentes).

**Technical Context**
- Repositorio vacío (solo README); sin código que reutilizar.
- Claude Code (docs oficiales code.claude.com, consultadas 2026-11-08): hooks configurables en `~/.claude/settings.json` con handler `http` (POST JSON); eventos relevantes `UserPromptSubmit`, `Notification` (con `notification_type`: `permission_prompt`, `idle_prompt`…), `Stop`, `StopFailure`, `SubagentStart/Stop`, `SessionEnd`; campos comunes `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Transcripts documentados como formato interno. `claude agents --json` para sesiones en segundo plano. Deep links `claude-cli://` sin ID de sesión. Cobertura de hooks en la app de escritorio no documentada; indicio positivo observado (hooks de plugins disparados en una sesión de la app de escritorio).
- Electron en Windows: `setIgnoreMouseEvents(..., {forward:true})` solo reenvía movimiento; ventanas transparentes sin sombra nativa ni redimensionado; `backdrop-filter` no desenfoca el escritorio; Mica/Acrylic solo en ventanas rectangulares; no hay API para el estado de ventanas de otras apps (de ahí `koffi` + Win32).

---

*Generated: 2026-11-09*
*Status: MVP terminado (M0-M4 en `dev`, 2026-11-10); en validación de 2 semanas*

---

## Cambio de dirección (2026-11-09) — Integraciones vivas en el notch

**Decisión del usuario:** el notch no debe ser un lanzador de favoritos que haya que configurar, sino un punto desde el que **interactuar con herramientas sin salir del trabajo**. Cada integración es un icono en el panel que, al pulsarlo, despliega una mini versión de esa herramienta dentro del notch. Se empieza por una **terminal de PowerShell real**; después se decidirán otras integraciones.

**Sustituye a:**
- M2 "Quick Launcher (favoritos)": construido y probado, pero **aparcado** en la rama `feat/m2-quick-launcher` (sin mergear).
- "What We're NOT Building → terminal embebida": ahora **dentro de alcance**.
- Regla "sin ejecución arbitraria de comandos": pasa a **"solo se ejecuta lo que el usuario escribe en la terminal"** (aprobado por el usuario). Mitigaciones: sin contenido remoto y con CSP estricta (solo `style-src` admite `'unsafe-inline'`, que xterm.js necesita); la sesión la crea solo el proceso main; ningún otro canal IPC puede escribir en ella. *Actualizado en el diseño de M2:* la terminal se pinta en el mismo renderer del notch (decisión del usuario) y el aislamiento se garantiza en main: los canales `terminal:*` solo aceptan el webContents del notch (ver `docs/superpowers/specs/2026-11-09-m2-terminal-design.md`).

**Nuevo M2 · Integraciones + terminal PowerShell:**
- Fila de iconos de integraciones en el panel expandido (la terminal es la primera).
- Click en el icono → el notch se expande a un panel de ~640×360 con una sesión real de PowerShell (`node-pty` + `xterm.js`): colores, autocompletado, historial, Ctrl+C.
- La sesión sigue viva al cerrar el panel y se recupera al volver; se termina al salir de la app.
- Estilo Obsidian (tema de xterm con los tokens de DESIGN.md, Geist Mono).

**Riesgos nuevos:**
- `node-pty` es un módulo nativo que debe compilarse para Electron 45 (riesgo alto) → validar primero con una prueba aislada; plan B: probar la versión con binarios precompilados o ConPTY directo.
- El foco del teclado en una ventana transparente siempre encima: la terminal debe recibir el foco al abrirse y devolverlo al cerrarse.
- El consumo de memoria crece con la sesión de PowerShell y xterm: medir en reposo.

**Criterios de aceptación del nuevo M2:**
1. Un icono de terminal en el panel abre una sesión real de PowerShell dentro del notch en < 1 s.
2. Se pueden ejecutar comandos interactivos (p. ej. `Get-ChildItem`, `git status`, Ctrl+C para cortar `ping -t`).
3. Cerrar el panel no mata la sesión; reabrirlo muestra la misma sesión con su historial.
4. Ningún canal IPC distinto de la propia terminal puede escribir en la sesión (verificado con tests).
5. Esc no cierra la terminal mientras tiene el foco (se usa un atajo propio para salir), y el foco vuelve a la app anterior al cerrar.

---

## M4: cambios respecto al PRD original (2026-11-10)

- Los recordatorios son una **integración del notch**, no un buscador en la cápsula: no hay caja de búsqueda en la cápsula.
- Vista del notch: lista + botón "+" que abre un formulario (texto, Hoy/Mañana/Otro día, hora en 24 h, repetición Una vez/Cada día/Laborables).
- La página de Control Center conserva los atajos de texto ("en 30 min …", "16:00 …", "laborables 9:30 …") y la edición.
- Toast **sin botones**: el click en el cuerpo abre la vista de recordatorios, porque no se pudo verificar que el click en un botón llegara a la app (ver `docs/spikes/m4-toast-findings.md`).
- Sonido propio (chime).
- Con "No molestar" activado en la máquina del usuario, los toasts van directos al Centro de notificaciones.

## Validación (2 semanas) — desde 2026-11-10

La app guarda un registro local de uso (Control Center → Acerca de): días de uso, horas de uso por día, arranques, recordatorios disparados/perdidos/completados, alertas de Claude y latencia de las alertas (desde que la petición del hook llega al bridge local hasta el cambio de estado de la cápsula; **no incluye** el pintado del renderer).

| Métrica del PRD | Cómo se mide ahora |
|-----------------|--------------------|
| Uso diario sostenido | Días de uso y horas por día del registro local, más autoevaluación |
| Comprobaciones manuales de la app Claude | Solo autoevaluación al final de las 2 semanas (el registro no lo mide); se puede contrastar con las alertas de Claude registradas |
| Latencia de aviso de Claude | Latencia del registro (hook → bridge → cambio de estado de la cápsula). Sin el pintado, por lo que es un límite inferior del tiempo percibido |
| Tiempo para abrir un favorito | **Ya no aplica** (launcher aparcado) |
| Favoritos abiertos desde la cápsula | **Ya no aplica** (launcher aparcado) |
| Recordatorios cumplidos | Recordatorios disparados / perdidos / completados del registro |
| Consumo en reposo | Administrador de tareas (medido en M1 por el controlador: 0,02 % CPU, 124 MB con la app empaquetada, sin fuente en el repo; el spike M2 midió 183 MB privados / 354 MB working set en desarrollo); el objetivo de 200 MB queda **pendiente de confirmar con la app instalada**; repetir tras días de uso |

Sugerencia, no compromiso: sustituir las dos métricas del launcher por "aperturas de integraciones" (terminal, recordatorios…) si resulta útil medirlas.

Siguen sin verificarse: DPI mixto y multi-monitor, y los botones del toast (ver arriba).

## System Monitor (núcleo) — hecho tras el MVP (rama `feat/system-monitor`)

Estaba como "Could" en la Fase 4; se adelantó al terminar el MVP. Diseño: `docs/superpowers/specs/2026-11-10-system-monitor-design.md`; plan: `docs/superpowers/plans/2026-11-10-system-monitor.md`; hallazgos: `docs/spikes/system-monitor-findings.md`.

**Qué hace**
- La cápsula compacta muestra CPU, RAM y batería junto a hora y fecha; su ancho tiene tres valores (168 / 299 / 358 px) con un latch de 3 muestras para que no parpadee.
- Un panel "Sistema" (520×280) con tarjetas y sparklines de 60 s, línea de discos y lista de procesos, con opción de cerrar un proceso. _(Cambio del usuario, 2026-11-11: 5 procesos y panel de 520×280, antes 8 y 520×360.)_
- Muestreo en el main: ligero cada 3 s; completo cada 1 s solo con la vista abierta; en pausa en `mini`, `hidden` y alerta. La línea base de las métricas solo se reinicia tras una pausa ≥ 10 s.

**Coste en reposo medido:** media de 0,061 % de CPU sumada sobre todos los procesos de la app, en compact (E2E).

**Seguridad al cerrar procesos:** el botón solo aparece en procesos cerrables; hay confirmación en línea ("Cerrar" a la izquierda de "Cancelar"), foco en "Cancelar" y 300 ms de armado antes de que "Cerrar" responda; el resultado se informa en la fila.

**Hito 2: avisos por umbral — hecho (rama `feat/system-alerts`).** Diseño: `docs/superpowers/specs/2026-11-11-system-alerts-design.md`; plan: `docs/superpowers/plans/2026-11-11-system-alerts.md`.
- CPU ≥ 90 % sostenido 30 s, RAM ≥ 90 %, batería ≤ 15 % desenchufada y peor unidad fija < 10 % libre, con histéresis fija de 5 puntos; umbrales ajustables y desactivables en Control Center → Sistema (campos enteros que rechazan lo inválido mostrando el rango, sin recortar).
- Solo color (Rojo Fallo en icono y cifra de la cápsula y en la cifra de la vista Sistema) más un bloque de disco en la cápsula mientras el aviso está enganchado (anchos 168 / 299 / 358 / 376 / 435 px). Un aviso nunca abre la cápsula, cambia de modo, lanza un toast ni suena.
- Evaluación en el main, que falla en abierto (si falla, la muestra sale sin avisos); el espacio libre se lee como mucho cada 60 s en el ritmo ligero.
- Coste en reposo medido: 0,034 % de CPU de media (todos los procesos de la app, compact, E2E).
- Posible futuro: excluir unidades concretas del aviso de disco (hoy cuenta toda unidad fija).

**Pendiente**
- Hito 3: batería Bluetooth; empieza con una sonda de viabilidad.
- Comprobaciones manuales: comparar las cifras con el Administrador de tareas y cerrar un proceso real propio.

**Bug previo encontrado y corregido en esta rama (cuelgue al salir):** la app no terminaba tras ~60 s en reposo, porque el segundo `app.quit()` se ejecutaba en una microtarea dentro del `will-quit` ya cancelado (`preventDefault`). Afectaba también a "Salir" de la bandeja. Introducido en el commit `7db549b`.

## Notas rápidas — hecho tras el MVP (rama `feat/notes`)

Nueva integración viva del notch, solo en el notch (sin página en Control Center). Diseño: `docs/superpowers/specs/2026-11-11-notes-design.md`; plan: `docs/superpowers/plans/2026-11-11-notes.md`.

**Qué hace**
- Panel "Notas" (420×320): lista de notas cortas (hasta 2000 caracteres, multilínea; máximo 500), fijadas arriba y después por fecha de edición; buscador inmediato que ignora mayúsculas y acentos.
- Copiar (main escribe el portapapeles a partir del `id`; el renderer nunca envía el texto), editar (Ctrl+Enter guarda, Esc cancela), fijar/desfijar y borrar con barra "Deshacer" durante 5 s (main conserva la borrada 10 s).
- Guardado en `userData/notes.json` con el patrón de los recordatorios: escritura atómica y serializada, cuarentena si el archivo está corrupto y solo lectura si viene de una versión más nueva. Al salir, la app espera a que termine la escritura en curso (acotado por el mismo límite de 2 s del vaciado de uso).

**Privacidad:** el texto de las notas nunca se escribe en el log (solo ids, recuentos y nombre/código de los errores); todos los canales `notes:*` solo aceptan el notch.

**Pendiente**
- Comprobaciones manuales: copiar y pegar en otra app real, y el uso diario durante la validación.

## Gmail — hito 1 hecho tras el MVP (rama `feat/gmail`)

Nueva integración viva del notch, con página propia en Control Center. Diseño: `docs/superpowers/specs/2026-11-11-gmail-design.md`; plan: `docs/superpowers/plans/2026-11-11-gmail.md`; guía de configuración para el usuario: `docs/gmail-setup.md`.

**Qué hace**
- Inicio de sesión con Google (OAuth 2.0 para apps de escritorio, PKCE S256 y `state`, en el navegador predeterminado con retorno a `http://127.0.0.1:<puerto>/callback`) con un cliente "Aplicación de escritorio" del propio usuario; permiso `gmail.readonly`. Sin SDK: `fetch` desde main y respuestas validadas con zod.
- La cápsula compacta muestra un bloque `Mail` + cifra ("3", "99+") con los sin leer de **Principal**, con el latch de 3 lecturas de la cápsula; con 0 o sin sesión no ocupa sitio.
- Panel "Gmail" (420×382): los 5 correos más recientes de Principal (remitente, hace cuánto, asunto y extracto; no leídos en negrita con punto azul hielo), Actualizar y abrir un correo o la bandeja en el navegador (main construye la URL a partir del id).
- Control Center → Gmail: ID y secreto del cliente (o cargar el JSON de Google), Iniciar / Cancelar / Cerrar sesión, cuenta conectada y avisos (caducada, sin conexión, sesión no recordada).
- Ritmo: contador cada 60 s con la cápsula visible (nada en `mini`, `hidden` ni alerta; **cambio 2026-11-12:** Gmail consulta en todos los modos mientras haya sesión, y todas las alertas (permiso de Claude, recordatorio y correo nuevo) se muestran también con la cápsula en `mini` u oculta); con la vista abierta también la lista. Red caída, 5xx, 429, 403 o una petición OAuth de más de 30 s → "sin conexión" con los últimos datos y espera creciente (1 → 2 → 4 → 5 min). 401 → un refresco y, si falla, "Vuelve a iniciar sesión".
- Con 5 casillas en la fila de integraciones, las sesiones de Claude del panel expandido pasan a su propia línea bajo la fila (alto 236 / 284 / 308 px según las sesiones).

**Privacidad:** el token de refresco solo vive en main y en disco cifrado con `safeStorage` (DPAPI); si no se puede cifrar, la sesión no se guarda y Control Center lo indica. Tokens, secreto, remitentes, asuntos y extractos nunca se escriben en el log (solo estados, recuentos y códigos de error); los canales de lectura solo aceptan el notch y los de sesión solo el Control Center.

**Pruebas:** unitarias de OAuth, cliente, integración, IPC y renderer; E2E con un servidor falso de Gmail y OAuth que inicia sesión siempre por el flujo completo (nunca con un token sembrado).

**Pendiente**
- ~~Hito 2~~ y ~~hito 3~~: hechos en `feat/gmail-actions` (ver la sección siguiente).
- Comprobación manual del usuario: el inicio de sesión real con su cuenta siguiendo `docs/gmail-setup.md` (los tests solo usan el servidor falso). Con la pantalla de consentimiento en modo Testing, Google caduca la sesión a los 7 días.

## Gmail — hitos 2 y 3 hechos (rama `feat/gmail-actions`)

Diseño: `docs/superpowers/specs/2026-11-12-gmail-actions-design.md` (con la nota "Cambio" de lo decidido durante la implementación); plan: `docs/superpowers/plans/2026-11-12-gmail-actions.md`.

**Qué hace**
- **Leer** un correo de Principal dentro del notch, como texto plano (la parte `text/plain` o el HTML convertido en main con `html-to-text`; nunca se pinta HTML): remitente, asunto, fecha, cuerpo (≤ 50 000 caracteres), enlaces `http`/`https` abribles en el navegador (≤ 50, por índice) y número de adjuntos. La lectura ocupa 520×440.
- **Marcar como leído** y **borrar para siempre** (`messages.delete`, sin papelera) desde la fila o la lectura, con confirmación en línea obligatoria; main solo actúa sobre ids que mostró al notch.
- **Avisos de correo nuevo** en la cápsula (alerta de prioridad más baja, 6 s, sin robar el foco), comparando los ids no leídos entre consultas; ajustes en Control Center → Gmail → Avisos (activar, ocultar remitente y asunto, sonido). `settings.json` v5.
- **Permiso completo** `https://mail.google.com/` (necesario para el borrado definitivo): una sesión con un permiso menor queda caducada y el notch y Control Center piden volver a iniciar sesión para concederlo.

**Pruebas:** unitarias (extracción de texto, detector, cliente, integración, IPC, ajustes, renderer) y E2E con el servidor falso ampliado (leer, enlaces, marcar, borrar, avisos, permiso insuficiente), con capturas ES/EN.

**Pendiente**
- Comprobación manual del usuario: volver a iniciar sesión con el permiso nuevo (añadir `https://mail.google.com/` en "Acceso a datos" según `docs/gmail-setup.md`) y borrar de verdad un correo de prueba.

## Preguntas de Claude — hecho (rama `feat/claude-questions`)

Diseño: `docs/superpowers/specs/2026-11-12-claude-questions-design.md` (con la nota "Cambio" de lo decidido durante la implementación); plan: `docs/superpowers/plans/2026-11-12-claude-questions.md`; prueba de viabilidad: `docs/spikes/askuserquestion-findings.md`.

**Qué hace**
- Contestar desde el notch las preguntas de Claude Code (`AskUserQuestion`) con un hook `PreToolUse` HTTP: aviso "Claude te pregunta · proyecto" (misma prioridad que un permiso, también con la cápsula en `mini` u oculta, más toast), tarjeta de 520×504 con opciones (radio o casillas), "Otro…" de texto libre, "Responder en Claude" y "Enviar", todo con teclado (Ctrl+Enter envía; nada se envía sin acción explícita).
- Main construye las respuestas solo con las preguntas que recibió; los textos nunca se escriben en el log. Si no hay respuesta, la pregunta se suelta y Claude muestra su diálogo.

**Pruebas:** unitarias (esquema, broker, instalador, estado del notch, IPC, renderer) y E2E con el bridge real y un cliente de hook simulado, con capturas ES/EN.

**Pendiente**
- Comprobación manual del usuario: reinstalar los hooks desde Control Center (los ya instalados salen como "Desactualizados: reinstala") y contestar una pregunta real de Claude desde el notch.

## GitHub y GitLab — hito 1 hecho (rama `feat/code-review`)

Diseño: `docs/superpowers/specs/2026-11-13-code-review-design.md` (con la nota "Cambio" de lo decidido durante la implementación); guía de configuración para el usuario: `docs/code-review-setup.md`.

**Qué hace**
- Conexión de github.com y de un GitLab propio (URL `https`) con tokens personales de solo lectura, cifrados con `safeStorage` y nunca enviados al renderer ni al log; sin OAuth. Control Center → "GitHub y GitLab" (token, URL, Comprobar y guardar, Quitar, avisos y sonido).
- Cápsula compacta: un bloque por plataforma (icono Github/Gitlab + número, "99+" a partir de 100) con los PR/MR propios, abiertos, no borrador y sin revisar; desaparece al momento cuando el recuento llega a 0.
- Aviso (misma prioridad que el correo, 6 s, también con la cápsula en `mini` u oculta, con `chime`) cuando alguien revisa por primera vez un PR/MR propio: Aprobado, Cambios pedidos o Revisado; clic abre "Míos".
- Panel "Revisiones" (480×440): pestañas GitHub | GitLab, secciones "Por revisar" y "Míos", filas con estado, checks y conflictos; abre en el navegador solo URLs de la última lista.
- Consulta cada 120 s en cualquier modo, con espera creciente; 401 → "Revisa el token". `settings.json` v6.

**Pruebas:** unitarias (clientes, detector, integración, IPC, migración, latch y anchos) y E2E con servidores falsos de GitHub GraphQL y GitLab REST, con capturas ES/EN.

**Pendiente**
- Comprobación manual del usuario con tokens reales siguiendo `docs/code-review-setup.md`.
- Hito 2: contribuciones (gráfico del mes y resumen de hoy, semana y mes), con spec propio.
