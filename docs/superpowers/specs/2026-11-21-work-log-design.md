# Registro de trabajo — Diseño

**Fecha:** 2026-11-21 · **Versión:** 0.4.0 · **Rama:** `feat/work-log` (desde `dev`)
**Fuentes:** conversación con el usuario (2026-11-21), `DESIGN.md`, el puente de hooks de Claude (`src-tauri/src/claude/*`), la vista de Redmine (lista y detalle a vista completa) y la prueba desechable del 2026-11-21 (abajo).

## Intención

El usuario trabaja con una segunda cuenta de Claude Code (`claude-work`, una función de su perfil de PowerShell que pone `CLAUDE_CONFIG_DIR=~/.claude-work`) y luego imputa a mano en Redmine el tiempo de cada sesión. Quiere que, sin hacer nada, cada sesión de esa cuenta quede medida y descrita: una **tarea macro** con sus **subtareas**, cada una con su tiempo, como el resumen que le pidió a Claude en la sesión «Integración con pasarela Cashela» (14 subtareas agrupadas por resultado; las 8 primeras hechas y las 6 últimas pendientes). Así, al imputar, solo tiene que copiar.

## Objetivos

- Medir **automáticamente** cada sesión de la cuenta elegida: empieza al abrir la sesión y termina al cerrarla, sin acción del usuario.
- Dos tiempos, uno al lado del otro: **Claude** (solo mientras Claude trabaja) y **Total** (toda la sesión, sin las pausas largas).
- Al terminar la sesión, una **entrada** en una sección nueva, «Registro de trabajo», con la tarea macro y sus subtareas, hechas (con sus dos tiempos) y pendientes (sin tiempo), redactadas por Claude.
- Ver la sesión en curso: cronómetro en la cápsula y entrada «en curso» en el registro.
- Asociar el notch a **varias cuentas de Claude** y elegir **una** para el registro.

## No objetivos

- Imputar en Redmine, proponer la tarea de Redmine o consultar Redmine (el usuario imputa a mano: opción A).
- Desglose por día (una entrada por sesión, aunque dure varios días, solo con el total).
- Editar a mano las entradas o crear entradas sin sesión.
- Medir sesiones mientras el notch está cerrado o recuperar después ese tiempo.
- Medir varias cuentas a la vez.

## Anti-objetivos

- **Un tiempo que no se midió.** Claude nunca calcula ni estima tiempos: solo asigna tramos medidos a subtareas. Si el resumen falla, los tiempos medidos se conservan igual.
- **Tocar Redmine sin que el usuario lo vea.**
- **Romper lo que ya funciona** de Claude (estado, permisos, preguntas) en la cuenta personal al actualizar.
- **Escribir texto del usuario en logs.** Como Notas y Claude hoy, nunca se registran prompts, resúmenes ni descripciones.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Para qué | Tiempos para imputar a mano en Redmine (A: el notch solo apunta) |
| Subtareas | Bloques de trabajo agrupados por resultado, descritos como en el ejemplo de Cashela; las pendientes aparecen sin tiempo |
| Cuándo se escribe la lista | Al final de la sesión |
| Dónde | Sección nueva «Registro de trabajo», aparte de Notas; solo la escribe el notch |
| Tiempos | Claude y Total, uno al lado del otro |
| Sesiones largas | Una entrada por sesión aunque dure varios días; `--resume` sigue la misma entrada |
| Pausas | Una pausa sin actividad de más de 30 min no cuenta en el Total (configurable) |
| Desglose por día | No; solo el total |
| Acciones | Copiar (entrada o subtarea), Marcar imputada, Borrar con Deshacer; historial hasta que se borre |
| Recorrido | Lista y detalle a vista completa, como Redmine (opción A del boceto) |
| Durante la sesión | Cronómetro en la cápsula y entrada «en curso»; la marca de Claude sigue apareciendo mientras trabaja |
| Cuentas | Control Center → Claude lista todas las cuentas y el usuario marca a cuáles asocia el notch; Control Center → Registro de trabajo elige una de las asociadas |
| Cómo se genera el resumen | Opción 1: hooks + `claude -p` en segundo plano con la cuenta elegida |

## Enfoques considerados (cómo se genera el resumen)

1. **Hooks y resumen en segundo plano con `claude -p`** (elegido). El notch mide los tramos con los hooks y, al cerrar la sesión, lanza `claude -p` con `CLAUDE_CONFIG_DIR` de la cuenta elegida pasándole los tramos y la ruta del transcript; Claude devuelve la tarea, las subtareas y qué tramos van en cada una. Automático, usa la suscripción del usuario y reutiliza el puente y el instalador de hooks. Consume algo de uso de esa cuenta.
2. **Claude escribe el resumen dentro de la sesión** (instrucción en `CLAUDE.md`). Descartado: al salir de la sesión Claude ya no puede actuar, así que el usuario tendría que pedirlo antes de salir; deja de ser automático.
3. **API de Anthropic directa.** Descartado: exige una clave aparte con su propia facturación y enviar el transcript entero; más caro y complejo sin aportar nada.

## Prueba desechable (2026-11-21, Claude Code 2.1.329)

Con `claude -p --settings <hooks de registro>` y `CLAUDE_CONFIG_DIR=~/.claude-work`:

- Llegan `SessionStart` (`source: "startup"` o `"resume"`), `UserPromptSubmit` (`prompt`, `prompt_id`), `PreToolUse`/`PostToolUse`, `Stop` (`last_assistant_message`, `stop_hook_active`) y `SessionEnd` (`reason`). Todos llevan `session_id`, `cwd` y `transcript_path`.
- `--resume <id>` mantiene el mismo `session_id` y emite `SessionStart` con `source: "resume"`.
- `claude -p` funciona con la cuenta de trabajo.
- Las variables del proceso de Claude (como `CLAUDE_CONFIG_DIR`) llegan a los hooks de tipo comando; los nuestros son HTTP, así que la cuenta se identifica con una cabecera propia (abajo).
- No se comprobó: si `SessionEnd` llega cuando se cierra la ventana de la terminal de golpe. El diseño no depende de ello (ver «Sesión sin cierre»).
- La prueba dejó dos sesiones cortas en el historial de `~/.claude-work` (carpeta del scratchpad).

## Diseño

### Cuentas de Claude

- **Detección.** Una cuenta es una carpeta de configuración de Claude Code. Se detectan `~/.claude` (la por defecto; su perfil está en `~/.claude.json`) y cada `~/.claude-*` que tenga `.claude.json` con `oauthAccount`. Se muestran con `emailAddress` y `organizationName` de ese `oauthAccount` y el nombre de la carpeta; sin perfil, solo la carpeta. «Otra carpeta…» añade una a mano (debe existir).
- **Control Center → Claude** sustituye el instalar/quitar único por una lista de cuentas con un interruptor por cuenta. Asociar o quitar sigue el flujo actual por cuenta: diff de su `settings.json` antes de confirmar, copia de seguridad, escritura atómica, `notch-hooks.original.json` en su carpeta. El estado de los hooks (`installed`/`outdated`/`missing`) se muestra por cuenta.
- **Marca de cuenta.** Cada hook instalado lleva, además de `x-notch-token` y `x-notch-hook: 1`, la cabecera `x-notch-account: <id de la cuenta>`. El puente la lee y la pasa con el evento. El id es estable y no es dato personal (por ejemplo, un hash corto de la ruta de la carpeta, o el nombre de la carpeta). Un hook sin la cabecera (instalado por la 0.3.0) se trata como de la cuenta `~/.claude`.
- **Estado de Claude** (marca en la cápsula, permisos, preguntas, sesiones) funciona igual con todas las cuentas asociadas; las sesiones se distinguen por `session_id` como hoy.
- **Migración.** Si al actualizar `~/.claude/settings.json` tiene nuestros hooks, `~/.claude` queda asociada sin pedir nada; los hooks se marcan `outdated` hasta reinstalarlos con la cabecera nueva (o el notch los actualiza en el arranque si el cambio solo añade la cabecera — decisión del constructor, ver abajo).

### Medición

Por cada sesión de la cuenta elegida (eventos con su `x-notch-account`):

- **Inicio:** `SessionStart` (`startup`) crea la entrada «en curso». Si el primer evento que llega es otro (el notch arrancó con la sesión ya abierta), la entrada se crea con ese evento.
- **Tramo de Claude:** empieza en `UserPromptSubmit` y termina en el `Stop` (o `StopFailure`) siguiente. Se guarda `{ id, promptId, prompt (recortado), reply (recorte de `last_assistant_message` del `Stop`), tools (nombres y recuentos de las herramientas usadas), startedAt, endedAt }`. Reglas de cierre (decisión propia; el constructor verifica en 2.1.329 qué llega al interrumpir con Esc):
  - Un `UserPromptSubmit` con un tramo abierto cierra el anterior en su último evento.
  - Un tramo abierto cuando la sesión termina se cierra en su último evento.
  - Los eventos que llegan después del `Stop` sin tramo abierto (agentes o tareas en segundo plano) no crean tiempo de Claude, pero cuentan como actividad para el Total.
- **Tiempo de Claude:** suma de los tramos, quitando lo que Claude pasa esperando un permiso o una pregunta (de `PermissionRequest` o la pregunta hasta el siguiente evento de herramienta). Decisión propia: en ese rato Claude no trabaja.
- **Tiempo total:** desde el inicio hasta el último evento de la sesión. El tope de pausa (**30 min**, el ajuste `workLog.idlePauseMinutes`) solo se aplica a los huecos **fuera de un tramo**, cuando Claude no está trabajando; dentro de un tramo cuenta todo (una compilación larga es trabajo). Ejemplo: un hueco de 50 min entre una respuesta y tu siguiente mensaje suma 30. Así el tiempo de Claude nunca supera el Total.
- **Reparto del Total entre tramos** (base de las subtareas): cada tramo se queda con su duración más el hueco (con tope) hasta el inicio del tramo siguiente. El rato antes del primer prompt va al primer tramo y el rato tras el último `Stop` (con tope), al último. Así la suma de los tramos es exactamente el Total de la sesión, por construcción.
- **Fin:** `SessionEnd`. La entrada pasa a «resumiendo» y se lanza el resumen.
- **`--resume`:** `SessionStart` con `source: "resume"`, o un `UserPromptSubmit` (cambio del 2026-11-22: Claude Code no envía `SessionStart` a los hooks HTTP, comprobado en el registro del notch con 0 recibidos; la prueba desechable usó hooks de tipo comando), en un `session_id` que ya tiene entrada terminada reabre esa entrada: vuelve a «en curso», sigue sumando (el hueco entre el cierre y la reanudación cuenta como pausa) y, si estaba «imputada», pasa a «sin imputar».
- **Varias sesiones a la vez** de la misma cuenta: cada una su entrada y sus tiempos, aunque se solapen.

### Sesión sin cierre

Si `SessionEnd` no llega (ventana cerrada de golpe, notch reiniciado), la entrada sigue «en curso» y, tras `idlePauseMinutes` sin eventos, se muestra **«en pausa»** con la acción **Cerrar y resumir**. Si llega un evento de esa sesión, vuelve a «en curso». Al arrancar el notch, las entradas «en curso» guardadas pasan a «en pausa».

### Resumen

- Al terminar la sesión (o con Cerrar y resumir, o Reintentar), el notch lanza en segundo plano `claude -p --output-format json` con `CLAUDE_CONFIG_DIR` de la cuenta, en una carpeta propia del notch (no en el `cwd` de la sesión), sin herramientas que escriban (solo lectura del transcript), con un tiempo límite (p. ej. 5 min).
- Entrada del prompt: el `cwd` de la sesión y la lista de tramos ya condensada por el notch (`id`, prompt recortado, respuesta final recortada, herramientas usadas, horas). Decisión propia: así la entrada tiene un tamaño acotado aunque la sesión dure días, y el notch no necesita leer ni interpretar el transcript. Si la lista condensada pasa de un tope, se recortan más los textos de los tramos más largos, nunca se quitan tramos. `transcript_path` se incluye solo como referencia opcional que Claude puede consultar. Salida pedida: JSON validado con zod y su espejo en Rust:
  ```ts
  { title: string,                      // tarea macro
    subtasks: { title: string,          // descripción, como en el ejemplo de Cashela
                status: "done" | "pending",
                turnIds: string[] }[] } // solo en las "done"; cada tramo en una sola subtarea
  ```
- El notch calcula los tiempos: **Claude** de una subtarea = suma de sus tramos; **Total** = suma del reparto del Total de sus tramos (ver «Medición»). Los tramos que Claude no asigne, o que asigne mal, van a una subtarea «Otros» para que la suma de las subtareas dé siempre el total de la sesión.
- En español (el idioma de la app), sin tiempos en el texto.
- **Si falla** (sin `claude` en el PATH, sin red, sin cuota, salida inválida, tiempo agotado): la entrada se guarda «sin resumen», con sus tiempos y un título provisional (el inicio del primer prompt), y la acción **Reintentar**. Tras un `--resume`, el resumen se rehace con toda la sesión.
- Nunca se registran en los logs el prompt, las respuestas ni el resumen; solo el código de error. Los recortes de prompt y respuesta se guardan solo en `work-log.json`, en local.

### Registro (datos)

`userData/work-log.json`, con el patrón de Notas y Recordatorios (servicio serializado, escritura atómica, cuarentena si se corrompe). Por entrada: `sessionId`, `accountId`, `cwd`, `status` (`running` | `paused` | `summarizing` | `unsummarized` | `ready`), `invoiced: boolean`, `startedAt`/`endedAt` (ISO), `turns[]`, `events` mínimos para el total (o el total ya calculado por hueco), `summary` (`title`, `subtasks[]` con `status`, `turnIds`, tiempos calculados) y `updatedAt`. El renderer no escribe nada salvo `invoiced` y borrar.

### Interfaz

- **Tarjeta** en la fila de integraciones del panel, con el color de la integración: entradas sin imputar y el cronómetro si hay sesión en curso.
- **Vista lista** (tamaño ajustado al contenido, como Redmine): por entrada, el título, las fechas (`20/11` o `20/11 – 21/11`), «8 de 14 hechas», `Claude 3h 10m · Total 5h 45m` y una píldora de estado (en curso, en pausa, resumiendo, sin resumen, sin imputar, imputada). Las «en curso» y «en pausa» van arriba; después, por fecha de fin descendente.
- **Vista detalle** a vista completa: título, fechas, carpeta (`cwd`, solo el nombre), los dos tiempos, las subtareas numeradas (✓ hechas con `Claude · Total`, ○ pendientes con «pendiente») y las acciones Copiar, Marcar imputada / Quitar imputada, Borrar (con Deshacer). En «en pausa», Cerrar y resumir; en «sin resumen», Reintentar. Clic o Copiar en una subtarea copia esa subtarea.
- **Formato de copia:** texto plano como el del ejemplo (`Tarea: …`, `Subtareas: 1 - … (Claude 25m · Total 50m)`, …). Tiempos con el formato de horas de Redmine que ya existe (`1h 25m`).
- **Cápsula:** con una sesión en curso de la cuenta elegida, la zona de integraciones muestra el cronómetro del Total (`1h 25m`, Nunito, color de la integración, se actualiza cada minuto); la marca de Claude sigue a su lado mientras trabaja. Si hay varias, la más reciente. Se activa con «Mostrar en la cápsula» de la página Integraciones, como las demás.
- **Control Center → Registro de trabajo:** cuenta (selector con las cuentas asociadas; si la elegida deja de estar asociada, aviso «Elige una cuenta»), pausa máxima (min), y una línea que indica si `claude` está en el PATH.
- **Integraciones:** Registro de trabajo aparece con su interruptor, «Mostrar en la cápsula» y su color, como las demás (ajustes v10).
- Textos en español e inglés.

## Restricciones

- Tauri 2 + Rust en main, React 19 + Tailwind 4; contratos zod con espejo en Rust y fixtures de paridad.
- Ajustes v9 → v10 con migración automática (`workLog`, la nueva integración y la lista de cuentas asociadas).
- `DESIGN.md`: colores, tipografías y componentes existentes; la geometría de la cápsula (`COMPACT_ZONE`, `CAPSULE_BLOCK`) necesita un bloque nuevo, medido y reflejado en `notch/geometry.rs`.
- El instalador de hooks no toca grupos ajenos y sigue sus reglas actuales (UTF-8, JSON objeto, CRLF, copias).
- Solo Windows 11.

## Lo que queda al constructor

- El id exacto de cuenta y si los hooks antiguos se actualizan solos en el arranque o el usuario los reinstala (preferible solo, si el plan solo añade la cabecera y se muestra en el registro local).
- El texto exacto del prompt del resumen y cómo se le limita a solo leer el transcript (flags de `claude -p`).
- El tamaño de las vistas y el ancho del bloque nuevo de la cápsula, siguiendo los patrones medidos de 0.3.0.
- Límites de longitud (título, subtareas, prompt recortado) y retención de `turns` en sesiones muy largas.

## Cambios durante la implementación

- **Copiar** usa el idioma de la app (`copy_text(entrada, idioma, subtarea)`); no necesita el tope de pausa.
- **Subtareas numeradas por posición** (`1 - …`, `2 - …`), no por un número propio de cada una.
- **Notificaciones:** `permission_prompt` y `elicitation_dialog` no cierran un tramo (llegan a mitad del tramo, unos 6 s después de `PermissionRequest`). `SessionStart` con `source: "compact"` tampoco lo cierra; `startup`, `resume` y `clear` sí.
- **Tramos atascados** (p. ej. Esc sin `Stop`): `SessionEnd`, `SessionStart` y `Notification` no alargan un tramo abierto; lo cierran en su último evento real. El `tick` cierra un tramo inactivo más de la pausa máxima y lo marca atascado; un evento posterior del mismo tramo (`PostToolUse`, `Stop`) lo reabre. Una espera pendiente (permiso o pregunta) cuenta como espera, no como Claude.
- **Tiempo monótono:** el instante de cada evento se acota a `max(instante, último evento)`, así que los tiempos imputados nunca salen negativos aunque llegue un evento con hora anterior.
- **Entrada terminada:** una entrada con fin solo se reabre con `SessionStart` y `source: "resume"`; el resto de eventos se ignoran.
- **Resumen:** `claude -p --output-format json --settings <archivo>` (el archivo, en la carpeta propia del notch, lleva `disableAllHooks` y reglas `deny` para `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch` y `WebSearch`), `--tools Read`, `--allowedTools Read`, `--disallowedTools …`, `--permission-mode dontAsk` y `--strict-mcp-config`. Al agotar el tiempo se mata el árbol de procesos con `taskkill /T /F`.
- **`is_own_session`:** el notch ignora los eventos de hook de su propio resumen (su `cwd` es la carpeta del resumidor), para que cada resumen no cree una entrada nueva.
- **Cápsula:** el bloque del Registro de trabajo mide 73,5 px; la cápsula compacta más ancha pasa de 741 a 814 px y `WINDOW_WIDTH` de 854 a 926.
- **Control Center:** «Otra carpeta…» al asociar una cuenta de Claude es un campo de texto para pegar la ruta (no hay plugin de selector de carpetas).
- **Desarrollo:** `NOTCH_CLAUDE_HOME` fuerza la carpeta de Claude, solo con los overrides de desarrollo.
- **Hooks antiguos:** se actualizan solos al arrancar (con copia de seguridad) en las cuentas asociadas.
- **Ajustes:** una sola `SETTINGS_VERSION` 10 y una sola migración v9 → v10, compartida por las cuentas de Claude (`claudeAccounts`) y el registro (`integrations.workLog` y `workLog`): la 0.4.0 no se publicó entre medias.
- **Título provisional:** «Sesión del DD/MM · «…»» con los primeros 40 caracteres del primer prompt (espacios colapsados); los puntos suspensivos solo si se cortó. En inglés, «Session on DD/MM · “…”».
- **Id de cuenta:** `claude` para `~/.claude`; el nombre de la carpeta sin el punto para `~/.claude-*` (`claude-work`); cualquier otra carpeta, `dir-` y 8 cifras hex del SHA-256 de su ruta en minúsculas. Nunca lleva el correo.
- **Límites:** prompt recortado a 500 caracteres y respuesta a 1000 por tramo; el texto del prompt del resumen, a 60 000 (se recortan más los tramos más largos, nunca se quitan); título de la tarea y de cada subtarea, 300; como mucho 40 subtareas; `project` y `title` de la vista, 512 (el servicio los recorta para que la vista siga siendo válida).
- **Id de tramo:** el `prompt_id` del `UserPromptSubmit`; sin él, `t<n>` (posición desde 1).
- **«Otros»:** los tramos que Claude no asigna (o asigna mal) van a una última subtarea hecha «Otros» / «Other». Al mostrar y copiar, los tramos que el resumen guardado no conoce (los medidos tras un `--resume`) se añaden a esa «Otros» si el resumen ya termina con ella, o a una nueva, así que las subtareas siempre suman el Total.
- **Borrar:** una entrada borrada se puede restaurar 10 s; pasado ese tiempo queda como lápida vacía (sin tramos, resumen ni carpeta), para que los eventos que lleguen después de esa sesión no la recreen.
- **Pausa máxima:** de 5 a 240 minutos (30 por defecto).
- **Quitar una cuenta:** el interruptor muestra el diff de quitar los hooks (`claude:hooks-preview` con `mode: "uninstall"`, el plan real de desinstalación, con el token enmascarado), no el de instalarlos.
- **Esperas en el Total** (decisión del usuario «una pausa sin actividad de más de 30 min no cuenta en el Total»): el rato que Claude espera un permiso o una respuesta a una pregunta es pausa para el tope. Al acabar la espera (respuesta, `Stop`, cierre, reapertura de un tramo atascado) se descuenta del Total lo que pase de la pausa máxima, en el reparto de ese tramo, así que los tramos siguen sumando el Total; el tiempo de Claude sigue sin contar ninguna espera. El Total en vivo aplica el mismo tope mientras la espera sigue pendiente. Ejemplo: prompt a 0, permiso a 5 min, respuesta a 125, `Stop` a 126, pausa 30 → Claude 6 min, Total 36 (5 + 30 + 1).
- **Al arrancar:** solo las entradas «en curso» pasan a «en pausa»; las «resumiendo» (ya tenían fin) vuelven a pedir su resumen.
- **Borrar mientras resume:** el detalle no ofrece Borrar ni Marcar imputada mientras resume. Si el resumen llega con la entrada borrada (dentro de los 10 s), se guarda igual y Deshacer la trae con él; una entrada restaurada «resumiendo» sin resumen en marcha pasa a «sin resumen» (Reintentar).
- **Cifras vivas y copiadas:** solo las «en curso» se mueven en la vista; las «en pausa» muestran lo medido, que es lo que copia Copiar. Mientras está en curso no se ofrece Copiar (ni el canal lo acepta): sus cifras aún se mueven.
- **Minutos de las subtareas:** cada subtarea redondea su Claude y su Total a minutos por mayor resto, para que las subtareas sumen exactamente las cifras de la sesión, igual en la vista (TS) y en el texto copiado (Rust), con los mismos casos de prueba (`tests/parity/work-log-rounding.json`). Mientras una entrada reanudada está en curso, las subtareas suman el Total medido hasta su último evento; la cifra grande añade el rato desde entonces.
- **Fechas:** la vista muestra de la primera a la última actividad (el último evento de su último tramo), no hasta el `SessionEnd`, que puede llegar horas después.
- **Ventana:** en un área de trabajo más estrecha que la ventana (926 px; 1366 px al 150 % son 910) la ventana empieza en su borde izquierdo en vez de salirse hacia el monitor de al lado; su lado derecho, transparente, sobresale.
