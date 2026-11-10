# M4 · Recordatorios — Diseño

**Fecha:** 2026-11-10 · **Rama:** `feat/m4-reminders` (desde `dev`)
**Fuentes:** PRD (M4, criterios 21–24, y "Cambio de dirección 2026-11-09"), `PRODUCT.md`, `DESIGN.md`, diseños de M2 (terminal) y M3 (estado de Claude). Sustituye las tareas de M4 del plan del MVP.

## Objetivo

Que nada pendiente se olvide mientras la app está en marcha: crear un recordatorio en segundos desde el notch, recibir un aviso claro a su hora y resolverlo (posponer o completar) sin cambiar de ventana.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Dónde se crean | **Integración en el notch** (icono junto a la terminal) **y** página en Control Center. El buscador de la cápsula del PRD original ya no existe (M2 aparcado) |
| Formato de entrada | **Un campo de texto con atajos** (`en 30 min …`, `16:00 …`, `diario 9:00 …`) **más chips** `+15 min`, `+1 h`, `Mañana 9:00` |
| Aviso | **Cápsula + toast siempre + sonido propio**, también con la cápsula visible |
| Repetición | `none`, `daily` (diaria) y `weekdays` (lunes a viernes) |
| Almacenamiento | Archivo JSON con el patrón de `SettingsStore` (enfoque A). Descartados SQLite (módulo nativo innecesario) y toasts programados de Windows (interop WinRT frágil; los perdidos ya cubren la app cerrada) |
| Prioridad en la cápsula | Un permiso de Claude pendiente gana a un recordatorio vencido; el recordatorio queda como punto ámbar al lado |

## Modelo de datos

`src/shared/reminders/schema.ts` (zod):

```ts
Reminder = {
  id: string            // uuid, lo genera main
  text: string          // 1–200 caracteres, sin caracteres de control
  dueAt: string         // ISO 8601 UTC del próximo vencimiento
  repeat: 'none' | 'daily' | 'weekdays'
  localTime?: string    // 'HH:mm', solo si repeat ≠ 'none': hora de pared que se respeta tras cambios de horario (DST)
  state: 'pending' | 'due' | 'missed' | 'done'
  createdAt: string
  completedAt?: string
}
RemindersFile = { version: 1, reminders: Reminder[] }
```

- `pending`: aún no ha vencido. `due`: venció con la app en marcha y espera acción. `missed`: venció con la app cerrada. `done`: completado (solo `repeat: 'none'`).
- Un recordatorio que se repite nunca pasa a `done`: completarlo o detectar que se perdió calcula el siguiente `dueAt` a partir de `localTime` y vuelve a `pending` (los perdidos repetidos no se acumulan: solo se avisa de la última ocurrencia).
- Los `done` de más de 7 días se purgan al arrancar.
- Límite: 500 recordatorios no completados; crear más devuelve un error claro.

Ajustes nuevos en `settings.json` (migración a la siguiente versión del esquema): `reminders: { snoozeMinutes: 5 | 10 | 15 | 30 (por defecto 10), sound: boolean (por defecto true) }`.

## Analizador de texto

`src/shared/reminders/parse.ts`: función pura `parseReminder(input, now) → { text, dueAt, repeat, localTime? } | { error: ParseErrorCode }`. Bilingüe, sin depender del idioma de la interfaz. Hora local del sistema.

| Entrada | Resultado |
|---|---|
| `en 30 min revisar PR` / `in 30 min review PR` | ahora + 30 min (también `h`, `hora(s)`, `hour(s)`, `min`, `minuto(s)`, `minute(s)`) |
| `16:00 standup` / `4pm standup` | hoy a las 16:00; si ya pasó, mañana |
| `mañana 9:00 …` / `tomorrow 9:00 …` | mañana a las 9:00 |
| `diario 9:00 …` / `daily 9:00 …` | `repeat: daily`, primer vencimiento la próxima 9:00 |
| `laborables 9:30 …` / `weekdays 9:30 …` | `repeat: weekdays`, la próxima 9:30 de lunes a viernes |

- El patrón de tiempo va **al principio**; el resto es el texto. Texto vacío → error `empty-text`; sin hora reconocible → error `no-time` (la vista lo explica y sugiere un chip).
- Los **chips** no usan el analizador: envían `{ text, preset: '15m' | '1h' | 'tomorrow-9' }` y main calcula la hora.
- La vista previa del renderer usa el mismo analizador, pero **main vuelve a analizar** el texto recibido; la fuente de verdad es main.

## Arquitectura

### Main

- **`src/main/services/reminders-store.ts`**: lectura y escritura de `userData/reminders.json` con el patrón de `SettingsStore`: escritura atómica, validación zod, migraciones, cuarentena del archivo corrupto (se renombra y se empieza vacío, con aviso en el log) y actualizaciones serializadas. API: `list()`, `create()`, `update(id, patch)`, `remove(id)`.
- **`src/main/services/reminder-scheduler.ts`**: un único `setTimeout` al próximo `dueAt` entre los `pending`.
  - Se reprograma tras cualquier cambio del store y con `powerMonitor` `resume` y `unlock-screen`.
  - Red de seguridad: comprobación cada 60 s (los temporizadores se desfasan durante la suspensión). Si el siguiente vencimiento está a más de 24,8 días, el temporizador se acota (límite de `setTimeout`).
  - Al vencer: `pending → due` (todos los vencidos a la vez), emite un único aviso agrupado.
  - Al arrancar: los `pending` con `dueAt` pasado → `missed` (los repetidos se reprograman a su siguiente ocurrencia y se cuentan como perdidos una sola vez).
  - Reloj inyectable (`now()`), para pruebas.
- **`src/main/platform/reminder-toast.ts`**: `Notification` nativa con `silent: true` (el sonido lo pone el notch, para no sonar dos veces).
  - Un toast por tanda: un recordatorio → su texto; varios → "3 recordatorios" con los dos primeros textos; perdidos al arrancar → "Tienes N recordatorios perdidos".
  - Acciones **Posponer N min** y **Completar** si Electron 45 las entrega en Windows (ver "Riesgos"); click en el cuerpo → abre el notch en la vista de recordatorios.
- **Integración con la máquina de estados** (`src/shared/notch/state.ts`):
  - Nuevo campo `reminderDue: boolean` y evento `{ type: 'reminders', due: boolean }`.
  - `notchMode`: `alert` si `attention || reminderDue` (con la misma precedencia actual: panel abierto y oculto ganan).
  - Al expandir con `reminderDue` y **sin** `attention`, la vista inicial es `reminders`; con `attention`, sigue siendo `permission`.
  - `reminderDue` vuelve a `false` cuando no queda ningún `due` ni `missed`; si la vista abierta era `reminders`, **no** se cierra (a diferencia de `permission`, la lista sigue siendo útil).
- **Integración nueva**: `reminders` en `src/shared/integrations/registry.ts` (después de `terminal`), vista y modo `reminders` con cápsula de **420×320** en `geometry.ts`, y `reminders` en `PANEL_MODES`.

### IPC

| Canal | Entrada | Salida | Quién |
|---|---|---|---|
| `reminders:list` | — | `Reminder[]` (sin `done` de más de 7 días) | notch, Control Center |
| `reminders:create` | `{ input: string }` o `{ text, preset }` | `Reminder` o error de análisis | notch, Control Center |
| `reminders:update` | `{ id, text?, dueAt?, repeat? }` | `Reminder` | Control Center |
| `reminders:snooze` | `{ id }` | `Reminder` | notch, Control Center |
| `reminders:complete` | `{ id }` | `Reminder` | notch, Control Center |
| `reminders:delete` | `{ id }` | `null` | notch, Control Center |

Evento main → renderers: `reminders:changed` (lista completa; son pocos). Todo pasa por `registerIpc` (comprobación de sender, zod de entrada y salida, `Result`). Los `id` los genera main; operar sobre un id inexistente devuelve `not-found`.

### Renderer

- **Fila de integraciones**: icono `AlarmClock` (Lucide) con insignia numérica si hay `due`/`missed`.
- **Vista `reminders`** (420×320, `src/renderer/notch/reminders/`):
  - Campo de texto arriba, con el foco al abrir. Debajo, en vivo, la interpretación (*"Revisar PR · hoy 16:30"*, con ↻ si se repite) o el motivo del error en gris.
  - Chips `+15 min`, `+1 h`, `Mañana 9:00`: crean con el texto del campo y esa hora.
  - Enter crea. Esc vuelve a la fila de integraciones (si el campo tiene texto, el primer Esc lo vacía).
  - Lista: primero los `due`/`missed` (con **Posponer N min** y **Completar** visibles), después los `pending` de hoy y mañana (hora, texto, ↻; al pasar el ratón o con foco: **Completar** y **Borrar**). Enlace "Ver todos" al Control Center.
  - Aquí Enter y Espacio funcionan como en cualquier botón: ninguna acción es peligrosa (a diferencia de los permisos de M3).
- **Cápsula `alert`**: icono de reloj + texto truncado del recordatorio, o "3 recordatorios". Si hay a la vez un permiso de Claude, se muestra el de Claude y un punto Ámbar Espera indica el recordatorio.
- **Sonido**: tono corto incluido en la app (archivo local, sin red), reproducido por el renderer del notch cuando llega una tanda nueva, si `reminders.sound` está activo y la cápsula no está oculta por pantalla completa o presentación. Respeta el volumen del sistema.
- **Control Center → "Recordatorios"** (`RemindersPage.tsx`): grupos *Vencidos*, *Próximos*, *Se repiten* y *Completados (últimos 7 días)*; crear con el mismo campo; editar texto, fecha y hora, y repetición con un formulario normal; borrar; ajustes de duración de posponer y sonido.
- i18n ES/EN para todo, tokens de `DESIGN.md`, `prefers-reduced-motion` respetado.

## Errores y casos límite

- Archivo corrupto → cuarentena y lista vacía; el notch avisa una vez en la vista ("No se pudieron leer los recordatorios; se guardó una copia").
- Fallo al escribir → la operación devuelve error, el estado en memoria no cambia y la vista lo muestra.
- Cambio de hora (DST): los repetidos respetan `localTime`; una hora inexistente (p. ej. 2:30 al adelantar) se mueve a la siguiente hora válida.
- Cambio manual del reloj o de zona horaria: la comprobación de 60 s lo detecta y reprograma.
- Muchos vencidos a la vez: un solo toast, un solo sonido.

## Seguridad

1. Ningún canal ejecuta nada: los recordatorios solo guardan texto y avisan.
2. Entrada acotada (200 caracteres, sin caracteres de control) y validada en main; el texto se pinta como texto, nunca como HTML.
3. Los canales siguen el contrato zod con comprobación de sender; `reminders:update` solo desde el Control Center.
4. Los textos de los recordatorios no se escriben en el log (solo ids y estados).
5. El reloj controlable para pruebas solo existe si la app **no** está empaquetada.

## Riesgos

- **Acciones del toast en Windows**: no está garantizado que `Notification.actions` de Electron 45 entregue los botones en Windows. Primera tarea del plan: prueba aislada. Plan B: toast sin botones cuyo click abre el notch en la vista de recordatorios (donde están Posponer y Completar).
- **Temporizadores tras suspensión**: cubiertos por `resume` + comprobación de 60 s; se verifica a mano (criterio 23).

## Pruebas

- **Unitarias (TDD):**
  - Analizador con reloj fijo: cada formato en ES y EN, hora pasada → mañana, fin de semana para `weekdays`, cambios de día y de horario (DST), errores.
  - Store: migración, cuarentena, escrituras serializadas, purga de `done` antiguos, límite de 500.
  - Planificador con temporizadores falsos: vencimiento, agrupado, reprogramación tras cambios, `resume` simulado, perdidos al arrancar (incluidos los repetidos), límite de `setTimeout`.
  - `reduceNotch`: `reminders` encendido y apagado, prioridad frente a `attention`, vista inicial al expandir.
  - Contratos IPC: entradas inválidas rechazadas, `update` solo desde el Control Center.
- **E2E (Playwright):** directorio de datos temporal y reloj controlable (solo en desarrollo). Crear desde el notch con texto y con chip; avanzar el reloj → cápsula en alerta y lista con vencidos; posponer y completar; perdidos al arrancar; página de Control Center. Capturas de cada estado.
- **Manual en la máquina real:** toast con acciones (o plan B), sonido, suspender y reanudar con un recordatorio pendiente.

## Criterios de aceptación (adaptados del PRD)

21. Crear un recordatorio desde la vista del notch ("en 30 min revisar PR", "16:00 standup" o con un chip) en menos de 5 s.
22. A su hora: alerta en la cápsula, toast nativo y sonido; posponer y completar desde el notch (y desde el toast si la prueba de acciones sale bien).
23. Tras suspender y reanudar el PC, los recordatorios se reprograman y vencen bien.
24. Los vencidos con la app cerrada aparecen como "perdidos" al arrancar, con un solo toast.

## Fuera de alcance

Avisos con la app cerrada; repeticiones semanales personalizadas o mensuales; sincronización; recordatorios ligados a sesiones de Claude o a proyectos; historial más allá de 7 días.
