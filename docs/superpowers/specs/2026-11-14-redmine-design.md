# Redmine en el notch — Diseño

**Fecha:** 2026-11-14 · **Rama:** una rama `feat/redmine` desde `dev` (el usuario hace el PR) · **Versión:** última integración de la 0.1.0
**Fuentes:** `DESIGN.md`, `docs/superpowers/specs/2026-11-13-code-review-design.md` y `2026-11-13-contributions-design.md` (patrón GitHub/GitLab que se copia), `2026-11-14-panel-header-tiles-design.md` (panel actual), API REST de Redmine.

## Objetivo

Llevar el día a día de Redmine al notch: saber cuántas horas llevas hoy, esta semana y este mes; encontrar tus tareas asignadas, cambiarles el estado, estimarlas e imputarles horas, y un aviso si acabas la jornada sin haber imputado lo suficiente.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Resumen | Como las contribuciones de GitHub/GitLab: gráfico del mes en curso (un cuadrado por día) + Hoy · Semana · Mes, aquí en **horas imputadas** |
| Tareas | Buscar entre las tareas **asignadas a mí**, cambiar su estado, poner horas estimadas, imputar horas trabajadas |
| Extras elegidos | **Horas de hoy en la cápsula**, **aviso de fin de jornada** (no: aviso de tareas nuevas asignadas). El **cronómetro por tarea** se elige pero el usuario lo aparta a una funcionalidad posterior: fuera de esta spec |
| Panel | **9 baldosas**; el panel expandido pasa de **480 a 520 px** (fila de 494 px) |

## Propuestas aceptadas ("Comienza" tras la propuesta completa)

- Baldosa **Redmine** tras GitLab (orden: Terminal, Recordatorios, Sistema, Notas, Gmail, GitHub, GitLab, Redmine, Claude), con la marca de Simple Icons 13.21.0 `redmine` (CC0) en monocromo, `RedmineMark` en `brand-icons.ts`, atribución en `THIRD_PARTY_NOTICES.md`.
- Vista **Redmine** de 520×560 (como Revisiones). Detalle de tarea dentro de la vista.
- Bloque en la **cápsula compacta**: solo las horas de hoy (`5,5h`), sin el objetivo (cambio del usuario).
- **Control Center → Redmine**: URL del servidor + clave API (cifrada, como los tokens), jornada objetivo (8 h por defecto), aviso de fin de jornada (activado, 18:00, lunes a viernes, sonido activado).
- Estados: los permitidos para esa tarea (`include=allowed_statuses`, Redmine ≥ 5.0); si no vienen, la lista general (`/issue_statuses.json`).
- Sin conexión: últimos datos atenuados; las escrituras fallidas se avisan en la fila/formulario con "Reintentar".

## Enfoques considerados

1. **Módulo paralelo `redmine`** (elegido): `src/main/redmine/*`, `src/shared/redmine/*`, canales `redmine:*`, bloque de ajustes `redmine`, store y vista propios, copiando la forma del módulo code-review y reutilizando sus utilidades HTTP (`client-common.ts`: `sendRaw`, `send`, `readJson`, `statusError`, `mapPool`, `clip`). Redmine no es un sistema de PR/MR: meterlo en `Platform` obligaría a tocar cada `Record<Platform,…>` y mezclaría conceptos.
2. Extender `Platform = 'github' | 'gitlab' | 'redmine'`: descartado (ver arriba).
3. Hablar con Redmine desde el renderer: imposible y no deseado (CSP `connect-src 'self'`; la clave nunca sale de main).

## API de Redmine usada (todas con cabecera `X-Redmine-API-Key`, JSON)

| Uso | Petición |
|---|---|
| Validar clave / cuenta | `GET /users/current.json` → `user.id`, `login`, `firstname`, `lastname` |
| Tareas asignadas abiertas | `GET /issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc&limit=100&offset=N` (paginar hasta 3 páginas = 300; si hay más, "se muestran las 300 más recientes") |
| Detalle + estados permitidos | `GET /issues/:id.json?include=allowed_statuses` (si no trae `allowed_statuses`, `GET /issue_statuses.json` cacheado por sesión) |
| Cambiar estado / estimación | `PUT /issues/:id.json` con `{issue:{status_id}}` o `{issue:{estimated_hours}}` (204 = ok; 422 = errores de validación de Redmine, se muestran resumidos) |
| Actividades | `GET /enumerations/time_entry_activities.json` (cacheado por sesión; preselecciona `is_default`) |
| Imputar | `POST /time_entries.json` con `{time_entry:{issue_id, spent_on:'YYYY-MM-DD', hours, activity_id, comments}}` (201) |
| Horas imputadas | `GET /time_entries.json?user_id=me&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=100&offset=N` (paginado, máx. 10 páginas) |

Fechas en **fecha local** del equipo; la semana empieza en lunes; el rango del resumen es min(día 1 del mes, lunes de la semana) → hoy, en una sola consulta paginada.

## Diseño

### Main (`src/main/redmine/`)
- `redmine-client.ts`: `createRedmineClient({fetch, apiKey, baseUrl, allowLoopbackHttp?})` con `viewer()`, `issues()`, `issue(id)`, `statuses()`, `activities()`, `updateIssue(id, patch)`, `logTime(entry)`, `timeEntries(from, to)`. Esquemas zod sueltos (campos opcionales donde Redmine los omite). Reutiliza `client-common.ts` (redirect manual, mapeo 401/403 → `auth`, 422 → `validation` con mensajes recortados, timeout 30 s).
- `redmine-integration.ts`: estado `unconfigured | ok | offline | auth-error`, cuenta, horas de hoy, tareas, `updatedAt`. Sondeo cada **5 min** (horas de hoy + tareas) con backoff como code-review; el resumen del mes solo con la vista abierta (al abrir y cada 15 min). Tras cada escritura (estado, estimación, imputación) se vuelve a pedir lo afectado al momento. `setKey(url, key)` valida con `viewer()` antes de guardar (mismo flujo que "Comprobar y guardar"). `open(id)` abre `<url>/issues/<id>` tras comprobar el origen de la URL guardada.
- **Aviso de fin de jornada**: temporizador diario (lunes a viernes, hora local de ajustes) con la misma técnica que los recordatorios (setTimeout al siguiente disparo + intervalo de seguridad de 60 s + `powerMonitor` resume/unlock). A la hora, si hay sesión y `horasHoy < objetivo`, emite una alerta de cápsula "Llevas 5,5 h de 8 h hoy" (prioridad baja, como correo/revisión, 6 s) con sonido si está activado; clic abre la vista Redmine. Un disparo por día; si la app arranca después de la hora, no avisa.
- Clave API: `createSecureTokenStore({file: 'redmine.bin', logScope: 'redmine-token'})`. URL: misma normalización que GitLab (origen + ruta base, sin credenciales/query/hash, ≤ 512 caracteres). **https obligatorio** salvo el override de test.
- Override de test: `NOTCH_REDMINE_BASE_URL=http://127.0.0.1:PORT` (solo sin empaquetar), como `NOTCH_CODE_REVIEW_BASE_URLS`.
- Logs: solo estados, recuentos y códigos; nunca asuntos, comentarios ni la clave.

### IPC (`redmine:*`)
`get-state`, `issues` (lista para la vista), `issue` ({id} → detalle + estados permitidos), `activities`, `update-issue` ({id, statusId?, estimatedHours?}), `log-time` ({issueId, spentOn, hours, activityId, comments}), `summary` (resumen del mes), `view` ({open}), `refresh`, `open` ({id}), `set-key` ({url, key}) y `clear` (estos dos solo desde Control Center). Eventos: `redmine:state`, `redmine:summary-changed`, `redmine:alert`. Validación zod en entrada y salida; horas 0 < h ≤ 24 con 2 decimales; comentario ≤ 255; fecha `YYYY-MM-DD` no futura.

### Ajustes (versión 7)
`redmine: { url: '', dailyTargetHours: 8, endOfDay: { enabled: true, time: '18:00', sound: true } }` con migración 6 → 7; objetivo entre 1 y 24 (pasos de 0,5); hora `HH:mm`.

### Notch
- Baldosa y modo `redmine` (`viewIntegrationIds`, `NotchMode`, `notchModeSchema`, `PANEL_MODES`, `CAPSULE_SIZES.redmine = 520×560`).
- **Vista** (cabecera de 32 px: `←`, "Redmine", Actualizar con descanso de 5 s):
  - Arriba, el resumen: gráfico del mes (mismas medidas y teclado que `ContributionGraph`; nivel por horas/objetivo: 0, ≤ 25 %, ≤ 50 %, < 100 %, ≥ 100 %) y tabla Hoy · Semana · Mes en horas.
  - Buscador (filtra al instante por asunto, proyecto o `#número`, sin distinguir mayúsculas ni acentos).
  - Lista de tareas: `#id` · asunto · estado · `gastado/estimado h` · proyecto. Enter/clic abre el **detalle**: estado (desplegable de permitidos), horas estimadas (campo numérico), **Imputar horas** (fecha = hoy, horas, actividad, comentario; Ctrl+Enter guarda), "Abrir en Redmine". Esc vuelve a la lista; Esc en la lista vuelve al panel.
  - Estados: sin configurar (botón a Control Center), "Revisa la clave API en Control Center", sin conexión (datos atenuados al 70 %), cargando (esqueletos), "No tienes tareas abiertas asignadas".
- **Cápsula compacta**: bloque `RedmineMark` + `5,5h` (decimales con coma en ES, punto en EN; reserva el ancho del peor caso `23,75h`) tras los bloques de revisión. Latch como los demás bloques. Ancho medido con Playwright en ES/EN y añadido a `compactWidthFor`/`WIDEST_COMPACT_WIDTH`.
- **Alerta** `redmineAlert` en `state.ts` (prioridad igual a correo/revisión; el más nuevo sustituye), `notch:redmine-alert`, rama en `Alert()`, sonido `playChime()`.
- Panel: `CAPSULE_SIZES.expanded.width` = 520; alturas (128/176/200) sin cambios salvo que la medición diga otra cosa.

### Control Center
Página "Redmine" (icono `RedmineMark`): URL, clave API (oculta, mostrar/ocultar), "Comprobar y guardar", estado ("Conectado como …", sin conexión, revisa la clave), Quitar; "Jornada": objetivo en horas; "Aviso de fin de jornada": interruptor, hora, sonido; pasos para obtener la clave ("Mi cuenta → Clave de acceso API → Mostrar"; el administrador debe tener activada la API REST). Guía `docs/redmine-setup.md`.

## Decisiones tras la revisión del constructor

El usuario no sabe aún la versión ni el tipo de certificado de su servidor ("No lo sé" a ambas). Decisiones (las marcadas *propuesta* son mías, para que el usuario las revise):

- **Servidor:** https obligatorio (con certificado válido). Si al probarlo su Redmine va por http o con certificado propio, se revisa entonces (*propuesta*).
- **Versión:** se usan `allowed_statuses` si vienen; si no, la lista general, y un 422 de Redmine se muestra en el detalle sin cambiar nada.
- **Horas gastadas en la lista** (*propuesta*): si `GET /issues.json` trae `spent_hours`/`total_spent_hours`, la fila muestra `gastado/estimado h`; si no, solo `estimado h est.`. Nunca se pide el detalle de cada tarea para esto.
- **Bloque de la cápsula** (*propuesta*): visible siempre que hay sesión (`ok` u `offline`), también con `0h`, desde la primera lectura; se oculta sin configurar o con la clave mal. `compactWidthFor` recibe un parámetro `redmine` y su ancho medido; el peor caso de la cápsula crece en consecuencia (se mide y se documenta).
- **Errores 403/404 al escribir** (*propuesta*): en lecturas, 401/403 → `auth-error` (como hoy). En escrituras (`PUT /issues`, `POST /time_entries`), 403 → error en el formulario "Redmine no te deja hacer este cambio" y 404 → "La tarea ya no existe o no tienes acceso", sin cambiar el estado de la sesión; 401 sí pasa a `auth-error`.

## No objetivos
Cronómetro por tarea (funcionalidad posterior, a petición del usuario), crear tareas, comentar o editar otros campos, ver tareas de otros, imputar sin tarea, informes por proyecto, aviso de tareas nuevas asignadas.

## Pruebas
- Unitarias: cliente (peticiones exactas y mapeo de errores), integración (sondeo, backoff, escrituras + refresco, aviso de fin de jornada en el límite de la hora y fines de semana), resumen (rangos, semana desde lunes, niveles), formateo de horas ES/EN, latch del bloque, ajustes v7 y migración, contrato IPC, geometría.
- e2e con un servidor falso `tests/e2e/fixtures/fake-redmine.ts` (valida clave y consultas): conectar en Control Center, ver horas en la cápsula, abrir la vista, buscar, cambiar estado, estimar, imputar, aviso de fin de jornada (con el reloj de test), 9 baldosas caben en ES/EN a 520 px.
- `npx tsc --noEmit -p tsconfig.web.json` limpio y `tsconfig.node.json` sin errores nuevos (el script `typecheck` se corta en los 10 preexistentes de `tests/e2e`), `npm run lint`, `npm test`, `npm run test:e2e`.

## Lo que queda al implementador
Nombres internos exactos, forma de los esquemas zod, cómo se reparte el código común con code-review (importar o mover a un módulo compartido), y los anchos medidos.
