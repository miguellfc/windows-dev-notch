# Fijar una tarea de Redmine como acceso directo — diseño

Fecha: 2026-11-22 · Rama: `feat/redmine-pin` (desde `dev`) · Tamaño: cambio pequeño-mediano, solo interfaz del notch.

## Intención

Al imputar horas, el usuario vuelve una y otra vez a la misma tarea de Redmine. Quiere fijarla («pinearla») desde su detalle y tener, en cualquier otra vista del notch, un icono que lo lleve directamente a ella, sin pasar por la búsqueda.

Palabras del usuario: «En Redmine, cuando seleccionemos la tarea en la que imputaremos horas, agregar en la parte superior un icono de un pin [...] algo como un acceso directo. [...] cuando se seleccione el icono cambiará a algún otro icono que haga referencia a despinear la vista. Si se pinea otra tarea de Redmine la que estuviera anteriormente pineada pasará automáticamente a despinearse. Una vez pineada una de las tareas de Redmine el icono de acceso directo a esa tarea saldrá en todas las vistas de la aplicación.»

## Objetivos

- En la cabecera del detalle de una tarea, un botón para fijarla o soltarla.
- Solo una tarea fijada a la vez: fijar otra suelta la anterior.
- Mientras haya una tarea fijada, un acceso directo (solo el icono) en la cabecera del panel y en las cabeceras de las vistas del notch, que abre el detalle de esa tarea.

## Fuera de alcance

- Guardar la fijación entre reinicios (decisión del usuario: solo mientras la app está abierta).
- Mostrar el acceso directo en la cápsula (peek o compacta).
- Fijar varias tareas o mantener una lista de recientes.
- Cualquier cambio en el Centro de Control, en los ajustes, en IPC o en Rust.

## Anti-objetivos

- Que el acceso directo saque al usuario de algo a medio escribir: no aparece en formularios ni editores.
- Que una tarea que ya no existe quede fijada indefinidamente, con un acceso directo que siempre falla.

## Enfoques considerados

- **A. Solo interfaz (elegido por el usuario).** La fijación y un «destino a abrir» viven en el store de Redmine del notch. Un componente compartido pinta el acceso directo en cada cabecera. No toca ajustes, IPC ni Rust.
- **B. En memoria en el proceso principal (Rust).** Main guarda la fijación y la emite por evento. Sobrevive a una recarga del WebView, pero obliga a un canal nuevo con contrato zod, espejo Rust y fixture de paridad. Es más trabajo sin una ventaja que se haya pedido.
- **C. En los ajustes (v11).** Descartado: el usuario no quiere que la fijación persista.

## Decisiones del usuario

- Dónde: la cabecera del panel y las cabeceras de las vistas de integración. La cápsula no cambia.
- Persistencia: ninguna. La fijación se pierde al cerrar la app.
- Si la tarea se cierra en Redmine, sigue fijada. Si al abrirla Redmine responde que no existe o que no hay acceso (404), se suelta sola y el detalle muestra su error habitual.
- Aspecto del acceso directo: solo el icono, con «#id asunto» en el tooltip y en el nombre accesible.

## Diseño

### Estado (`src/renderer/shared/redmine-store.ts`)

- `pinned: { id: number; subject: string } | null`: la tarea fijada.
- `openTarget: number | null`: la tarea que la vista de Redmine debe abrir. La pone el acceso directo y la consume la vista.
- Acciones: `pinIssue({ id, subject })` (sustituye a la anterior), `unpinIssue()`, `openPinnedIssue()` (pone `openTarget` y pide `window.notch.notch.openIntegration({ id: 'redmine' })`), `takeOpenTarget()`.
- `nextRedmineSession` (`src/renderer/shared/redmine/session.ts`) también olvida `pinned` y `openTarget` cuando la sesión termina o cambia la cuenta, igual que ya hace con el resumen del mes. Es una función pura y se prueba como tal.
- Cuando una lectura del detalle trae un asunto nuevo para la tarea fijada, se actualiza el asunto del tooltip.

### Botón de fijar (`RedmineIssueDetail.tsx`)

- Va al final de la cabecera «← #id asunto», con `headerIconButton`.
- Si la tarea no está fijada: icono `Pin` de lucide, etiqueta «Fijar tarea» / «Pin issue».
- Si está fijada: icono `PinOff`, etiqueta «Soltar tarea» / «Unpin issue». El botón lleva `aria-pressed` y el color de la integración (`--int`).
- Mientras el detalle no tiene asunto (carga sin fila previa), fija con el asunto que haya y lo completa en la primera lectura.
- Si la lectura de la tarea fijada responde 404, la tarea se suelta.

### Acceso directo (`src/renderer/notch/redmine/PinnedIssueShortcut.tsx`, nuevo)

- Aparece solo si hay una tarea fijada, la integración Redmine está activa (`viewAllowed('redmine', …)`) y la sesión está viva (`ok` u `offline`).
- Es un botón `headerIconButton` con el icono `Pin` en el color de Redmine, al final de la cabecera (`ml-auto` cuando es el primer elemento empujado a la derecha). Su nombre accesible y su tooltip son «Abrir #1234 Asunto» / «Open #1234 Subject».
- Al pulsarlo llama a `openPinnedIssue()`.
- Dónde se coloca:
  - en la cabecera del panel (`NotchApp.tsx` › `Panel`), antes del engranaje;
  - en `GmailView` y `MessageReader`, `NotesView` (la lista), `RemindersView` (la lista), `ReviewsView`, `WorkLogView` y `WorkLogDetail`;
  - en `RedmineView`, en la cabecera de la lista y en el detalle de cualquier tarea que no sea la fijada (en el detalle de la fijada ya está el botón de soltar).
- Dónde no se coloca (decisión propia): `PermissionCard` y `QuestionCard`, porque son avisos urgentes con su propio flujo; `NoteEditor` y `ReminderForm`, para no sacar al usuario de algo a medio escribir.

### Apertura en `RedmineView`

- La vista se suscribe a `openTarget`, tanto al montarse como si ya estaba abierta (`open-integration` sobre la misma vista no cambia el modo y no la vuelve a montar). Al ver un destino lo consume: vacía la búsqueda y abre el detalle con ese id (`pickedId`), aunque la tarea no esté en la lista; el detalle ya carga solo con el id.
- Desde ese detalle, ← y Esc vuelven a la lista de Redmine con la búsqueda vacía. Es el mismo `stepBack` de siempre.

### Textos (i18n ES/EN)

- `redmine.pin.pin`: «Fijar tarea» / «Pin issue»
- `redmine.pin.unpin`: «Soltar tarea» / «Unpin issue»
- `redmine.pin.open`: «Abrir #{id} {subject}» / «Open #{id} {subject}»

## Pruebas

- **vitest:**
  - el store y `nextRedmineSession`: fijar, sustituir, soltar, olvidar al terminar la sesión o cambiar de cuenta, y consumir el destino;
  - el detalle: alternar el botón (iconos, `aria-pressed`) y soltar la tarea ante un 404;
  - `PinnedIssueShortcut`: se oculta sin tarea fijada, con la integración apagada o sin sesión; al pulsarlo pide abrir Redmine;
  - `RedmineView`: abre el destino tanto al montarse como estando ya abierta.
- **cargo:** no hay cambios en Rust. Se ejecuta `npm run test:rust` para confirmar que sigue en verde.
- **e2e (`tests/e2e-tauri/specs/redmine.spec.ts`):**
  1. abrir una tarea y fijarla;
  2. volver al panel y comprobar que el acceso directo está en su cabecera;
  3. ir a otra vista (Notas) y abrir la tarea desde allí;
  4. fijar otra tarea y comprobar que la primera queda suelta;
  5. soltarla y comprobar que el acceso directo desaparece.

## Lo que queda al implementador

- La posición exacta del icono dentro de cada cabecera que ya tiene acciones a la derecha (refrescar, añadir). Regla: el acceso directo va en último lugar.
- Los nombres de los `data-testid`: `redmine-pin`, `redmine-pinned-shortcut`.

## DESIGN.md

Añadir el botón de fijar en el detalle de Redmine y el acceso directo en las cabeceras: el icono, el color, dónde aparece y dónde no.
