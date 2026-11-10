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
- Terminal embebida o chat con Claude desde la cápsula - duplica la app Claude y amplía mucho el alcance.
- Aprobar/denegar permisos de Claude desde la cápsula - pospuesto tras el MVP por impacto en seguridad (ver Could).
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

- [ ] ¿Las sesiones de la app de escritorio Claude disparan los hooks de `~/.claude/settings.json` de forma fiable? (indicio positivo; se valida en M0)
- [ ] ¿Qué campos trae exactamente `StopFailure` en su stdin/body? (no verificado en la documentación)
- [ ] ¿Se puede enfocar la sesión exacta en la app Claude y no solo la app? (no hay deep link documentado por ID de sesión)
- [ ] ¿Cómo se comporta `setIgnoreMouseEvents` + redimensionado de ventana transparente en Windows 11 con DPI mixto? (M0)
- [ ] ¿Detección de compartir pantalla? Solo existe la de modo presentación; ¿basta el atajo manual?
- [ ] ¿Aprobar permisos de Claude desde la cápsula aporta lo suficiente para justificar su riesgo? (post-MVP)

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
| Must | Quick Launcher con favoritos manuales (app, carpeta, proyecto, URL, comando de lista blanca) | Resuelve "ir a la app X" |
| Must | Estado en vivo de sesiones de Claude Code (trabajando / esperando / terminada / error / inactiva) con alerta y toast nativo | Resuelve "no me entero de que Claude me espera" |
| Must | Instalación de hooks de Claude Code desde la app con diff, backup, fusión y desinstalación | Integración segura con la configuración del usuario |
| Must | Recordatorios locales rápidos (relativos, a una hora, repetición diaria) con alerta en cápsula + toast | Resuelve "se me olvidan cosas" |
| Must | Control Center: favoritos, atajos, apariencia, integraciones, recordatorios | Configuración sin editar archivos |
| Should | Indicador de reuniones próximas (Google Calendar) | Fase 3; requiere OAuth |
| Should | Centro de notificaciones con historial (SQLite) y prioridades | Fase 2 |
| Should | Developer Toolbox | Fase 2; alcance por definir |
| Could | Aprobar / denegar permisos de Claude desde la alerta (hook `PermissionRequest`) | Mucho valor, pero decide sobre acciones de Claude; requiere diseño de seguridad propio |
| Could | Indexado del Menú Inicio y detección automática de repos | Comodidad; no esencial con favoritos |
| Could | System Monitor (CPU, RAM, batería, disco, red) | Fase 4 |
| Could | Otros proveedores de agentes (Codex, Gemini CLI…) | La arquitectura `AgentProvider` lo permite |
| Won't | Multiplataforma, launcher universal, terminal/chat embebido, sync en la nube | Ver "What We're NOT Building" |

### MVP Scope

M0 spike técnico + M1 Foundation + M2 Quick Launcher (favoritos) + M3 estado de Claude Code + M4 recordatorios locales. Es lo mínimo para probar la hipótesis: estado en vivo de agentes, acción rápida por teclado y avisos de lo pendiente, en una cápsula que no estorba.

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
| 1 | M0 · Spike técnico | Código desechable que resuelve las 4 incertidumbres críticas | pending | - | - | - |
| 2 | M1 · Foundation | Scaffold, contrato IPC, tokens, cápsula con todos los estados, ventanas, Windows integration, instalador | pending | - | 1 | - |
| 3 | M2 · Quick Launcher | Favoritos (CRUD), búsqueda, teclado, lanzamiento por ID | pending | with 4, 5 | 2 | - |
| 4 | M3 · Claude Code status | Bridge, instalador de hooks, registro de sesiones, alertas, toast | pending | with 3, 5 | 2 | - |
| 5 | M4 · Recordatorios | Recordatorios locales rápidos con alerta y toast | pending | with 3, 4 | 2 | - |
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

**Phase 3: M2 · Quick Launcher**
- **Goal**: Abrir cualquier favorito en < 2 s solo con teclado.
- **Scope**: CRUD de favoritos (app, carpeta, proyecto, URL, comando) en Control Center, búsqueda filtrada, navegación por teclado, LauncherService por ID, gestión de favoritos rotos.
- **Success signal**: Criterios 11-14 cumplidos.

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

**M1 · Foundation**
1. La app arranca en < 2 s; instancia única (un segundo arranque enfoca la existente).
2. La cápsula aparece arriba al centro del monitor correcto, nítida a 100/125/150 % y se reposiciona al conectar/desconectar monitores.
3. Fuera de la cápsula visible, los clicks llegan siempre a la app de debajo, en todos los estados.
4. `compact → expanded → compact` anima sin parpadeos ni saltos, a 60 fps percibidos; con reduced-motion solo fundidos.
5. Con ventana maximizada debajo pasa a `mini`; con app a pantalla completa o modo presentación pasa a `hidden`; vuelve sola al salir.
6. El atajo global abre/cierra desde cualquier app; Esc o click fuera cierran; si el atajo está ocupado se avisa.
7. Tray: mostrar/ocultar, Control Center, inicio con Windows, salir; cerrar la ventana oculta la app, no la cierra.
8. En reposo: CPU ≈ 0 %, RAM total < 200 MB sin integraciones abiertas.
9. El instalador NSIS instala, arranca con Windows si está activado y desinstala limpio.
10. `contextIsolation`/`sandbox` activos, CSP sin `unsafe-eval`, todo IPC inválido se rechaza (probado con tests).

**M2 · Quick Launcher**
11. Crear, editar, reordenar y borrar favoritos de los 5 tipos en Control Center, con validación en el formulario.
12. `Ctrl+Alt+Space` → escribir → `Enter` abre el favorito en < 2 s sin ratón.
13. Un favorito roto muestra un error claro y no rompe nada.
14. Los comandos se ejecutan con argumentos fijos y sin shell; el renderer solo envía IDs (verificado con tests).

**M3 · Claude Code status**
15. Instalar los hooks muestra diff, crea backup y conserva los hooks existentes; desinstalar deja `settings.json` como estaba.
16. Con una sesión en la app Claude, la cápsula refleja trabajando / esperando / terminado en < 1 s desde el evento.
17. "Claude espera permiso" dispara la alerta de la cápsula y, si está oculta, un toast nativo.
18. Click en una sesión pone la app Claude al frente.
19. Con la app Claude cerrada o sin hooks, el módulo muestra "no conectado" y el resto funciona.
20. Sesiones sin eventos durante 30 min pasan a "inactiva" y se pueden descartar.

**M4 · Recordatorios**
21. Crear un recordatorio desde el buscador ("en 30 min revisar PR", "16:00 standup") en < 5 s.
22. A su hora: alerta en la cápsula y toast nativo, con acciones posponer y completar.
23. Tras suspender/reanudar el PC, los recordatorios se re-programan correctamente.
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
| Aprobar permisos de Claude | Post-MVP (Could) | En el MVP; nunca | Alto valor pero requiere diseño de seguridad propio |
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
*Status: DRAFT - needs validation*

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
