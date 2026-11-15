# M0 · Spike técnico — Hallazgos

**Fecha:** 2026-11-09 · **Rama:** `spike/m0` · **Código:** `spikes/m0/` (desechable, no se reutiliza)
**Entorno:** Windows 11, un monitor 1920×1080 al 100 %, Electron 45.2.3, koffi 3.3.7.
**Evidencia:** `spikes/m0/logs/spike.log` (local, fuera de git), capturas de la franja superior de la pantalla y pruebas manuales del usuario ("todo bien").

## Veredicto

El diseño aprobado se **confirma**. Ninguna de las dudas obliga a cambiar la arquitectura. Hay tres ajustes de implementación y dos pruebas que quedan abiertas (DPI mixto y los eventos `Notification`/`PermissionRequest`).

| Duda (plan) | Resultado | Decisión para M1/M3 |
|---|---|---|
| 0.2 Ventana transparente adaptable + morph | ✅ Sin recuadro negro, sombra correcta, sin parpadeo visible (confirmado por el usuario). Crecer: `setBounds` ~1–5 ms. Encoger tras animación: ~180–200 ms | Mantener el enfoque A |
| 0.2 Clicks en el margen transparente | ✅ Con `setIgnoreMouseEvents(true, { forward: true })` por defecto y desactivado solo mientras el puntero está sobre la cápsula, los clicks en el margen de sombra llegan a la app de debajo (confirmado por el usuario) | Este patrón pasa a `WindowManager` |
| 0.3 Maximizado / pantalla completa | ✅ Maximizada → `mini` en ~0,2 s. Pantalla completa sin bordes y YouTube a pantalla completa en Opera → `hidden`; vuelve al salir | Combinar dos señales (ver abajo) |
| 0.3 Coste del vigilante | ✅ ~0,56 ms por consulta a 2 Hz; proceso main completo ≈ 0,5 % CPU | Aceptable; valorar `SetWinEventHook` en M1 |
| 0.4 Hooks desde la app de escritorio Claude | ✅ Los hooks `http` llegan en vivo y **sin reiniciar Claude** (recarga `settings.json` en caliente). Recibidos: `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop` | Confirmado el diseño de M3 |
| 0.4 `Notification` / `PermissionRequest` | ❓ No se dispararon: la sesión estaba en modo automático (sin diálogos de permiso) y no llegó aviso de inactividad | Probar al inicio de M3 en una sesión con permisos manuales |
| 0.5 Foco con atajo global | ✅ El atajo toma el foco desde cualquier app; al cerrar (Esc / click fuera) Windows devuelve el foco a la app anterior sin ayuda | Sin trucos; solo `blur` + ocultar |
| 0.5 Traer la app Claude al frente | ⚠️ `SetForegroundWindow` devuelve `true` pero Windows lo **bloquea en silencio**. Funciona simulando una pulsación de Alt antes | Ver "Traer Claude al frente" |
| 0.6 DPI mixto / multi-monitor | ❓ No probado: hay un solo monitor y no se cambió la escala | Probar en M1 (cambio de escala en caliente al menos) |

## Detalles que cambian la implementación

### 1. La máquina de estados debe ignorar peticiones repetidas
Al cerrar con Esc, el evento `blur` pidió cerrar otra vez. La segunda petición encogió la ventana **antes** de que terminara la animación (`compact → compact` en el log), lo que corta la sombra. En M1, la máquina de estados (lógica pura, con tests) debe ignorar una transición hacia el estado al que ya se va, y el redimensionado debe esperar siempre a `transitionend`.

### 2. Detección de "estorbo": dos señales combinadas
- `SHQueryUserNotificationState` detecta `busy` / presentación / D3D, pero llegó ~0,5 s **más tarde** que la geometría.
- "La ventana en primer plano cubre su monitor" (`GetWindowRect` ⊇ `rcMonitor`) lo detecta en el primer sondeo.
- Maximizada = `IsZoomed`. Se ignoran el escritorio y la barra de tareas (`Progman`, `WorkerW`, `Shell_TrayWnd`) y la propia ventana.

### 3. Opacidad del panel expandido
Con la superficie de DESIGN.md (`rgba(14,14,16,.86)`), el **panel expandido deja leer el texto de la ventana de detrás**, porque no hay desenfoque real. En la cápsula compacta no molesta. **Propuesta:** subir el panel expandido a ~0,95 de opacidad, manteniendo 0,86 en la cápsula compacta, y reducir la sombra en `mini` (deja un halo tenue debajo de la píldora). Requiere actualizar DESIGN.md con tu aprobación.

### 4. Traer Claude al frente
- Ventana localizada por proceso `claude.exe` + ventana visible con título (`EnumWindows`).
- `SetForegroundWindow` sola: falla por el *foreground lock* aunque devuelva `true`.
- Con pulsación simulada de Alt: funciona. **Riesgo:** en apps con barra de menú clásica, la pulsación de Alt puede activar su menú. Alternativas a evaluar en M3: `AttachThreadInput` con el hilo de la ventana en primer plano, o `AllowSetForegroundWindow` cuando la acción venga de un click en la cápsula (que ya tiene el foco). Decidir con una prueba corta en M3.
- Sigue sin existir forma documentada de abrir **una sesión concreta** de la app de escritorio: "ir a la sesión" = traer la app al frente.

### 5. Coexistencia con otros hooks
El usuario ya tiene **Coucou** (`coucou-hook.exe`) en 12 eventos. El instalador de M3 debe añadir grupos propios sin modificar los existentes, marcarlos para poder retirarlos, y restaurar exactamente. El script del spike lo hizo así y la restauración quedó idéntica byte a byte.

## Payloads de hooks observados (solo campos, sin valores)

Todos llegan por POST con `user-agent: axios/…` y `content-type` JSON.

| Evento | Campos |
|---|---|
| `UserPromptSubmit` | `cwd`, `hook_event_name`, `permission_mode`, `prompt`, `prompt_id`, `scratchpad_dir`, `session_id`, `session_title`, `transcript_path` |
| `Stop` | `background_tasks[]`, `cwd`, `effort{}`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `scratchpad_dir`, `session_crons[]`, `session_id`, `stop_hook_active`, `transcript_path` |
| `SubagentStart` | `agent_id`, `agent_type`, `cwd`, `hook_event_name`, `prompt_id`, `scratchpad_dir`, `session_id`, `transcript_path` |
| `SubagentStop` | los de `Stop` + `agent_id`, `agent_transcript_path`, `agent_type` (uno de los dos recibidos no traía `last_assistant_message`) |

Implicaciones para M3:
- `session_title` permite mostrar el nombre de la sesión en la cápsula.
- `prompt` y `last_assistant_message` contienen texto del usuario y de Claude: **no** se registran en logs; como mucho se muestra un extracto en la UI.
- Los esquemas zod deben ser tolerantes (campos opcionales; `last_assistant_message` puede faltar).
- Configuración usada y validada: `{ "type": "http", "url": "http://127.0.0.1:<port>/hook", "headers": { "x-notch-token": "<token>" }, "timeout": 2 }`.

## Preguntas abiertas del PRD tras M0

- [x] ¿La app de escritorio dispara los hooks de usuario? **Sí**, en vivo y sin reiniciar.
- [ ] ¿Qué campos trae `StopFailure`? No se produjo ningún fallo durante la prueba.
- [x] ¿Se puede enfocar la sesión exacta? **No** documentado; se trae la app al frente (con la salvedad del foreground lock).
- [ ] ¿Clicks y redimensionado con DPI mixto? Clicks ✅; DPI mixto pendiente (un solo monitor).
- [ ] Detección de compartir pantalla: sin cambios (solo modo presentación).
- [ ] Nuevo: ¿llegan `Notification` y `PermissionRequest` desde la app de escritorio? Pendiente para el inicio de M3.
