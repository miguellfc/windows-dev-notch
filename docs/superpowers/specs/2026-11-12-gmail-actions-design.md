# Gmail en el notch — Hitos 2 y 3: leer, actuar y avisos — Diseño

**Fecha:** 2026-11-12 · **Rama:** `feat/gmail-actions` (desde `dev`)
**Fuentes:** `docs/superpowers/specs/2026-11-11-gmail-design.md` (hito 1, base), PRD (sección Gmail), `DESIGN.md`.

## Objetivo

Leer un correo de Principal sin salir del notch, marcarlo como leído o borrarlo, y enterarse de un correo nuevo con un aviso breve en la cápsula.

## Alcance (decidido con el usuario)

Este documento une los hitos 2 y 3 del plan de Gmail:

- **Leer** un correo dentro del notch, en **texto plano**.
- **Acciones**: **marcar como leído** y **borrar para siempre** (sin papelera). No se archivan ni destacan correos.
- **Aviso de correo nuevo** en la cápsula, con ajustes.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Eliminar | **Borrar para siempre** (`messages.delete`), con **confirmación obligatoria** en línea y sin deshacer |
| Permiso | Pasa de `gmail.readonly` al permiso completo **`https://mail.google.com/`** (el único que permite el borrado definitivo). Requiere volver a iniciar sesión una vez |
| Lectura | **Texto plano**: la parte `text/plain` o el HTML convertido a texto. Nunca se pinta HTML |
| Conversión HTML → texto | Librería **`html-to-text`** (sin DOM), no un conversor propio |
| Marcar como leído | Botón explícito; **abrir un correo no lo marca** |
| Detección de correo nuevo | **Comparar los ids no leídos** de cada consulta con los de la anterior (enfoque A). Sin peticiones extra; latencia ≤ 60 s |
| Aviso | **Aviso en la cápsula** (modo `alert`, tipo correo) unos 6 s, sin robar el foco. Sin toast de Windows |
| Ajustes del aviso | Activar/desactivar, **ocultar remitente y asunto**, **sonido** |

## Permiso y sesión

- `GMAIL_SCOPE = 'https://mail.google.com/'`.
- main compara el `scope` que devuelve Google al refrescar o iniciar sesión con el requerido. Si falta (una sesión del hito 1 con `gmail.readonly`), el estado pasa a **`expired`** con `reason: 'scope'`, y el notch y Control Center muestran "Vuelve a iniciar sesión para conceder el nuevo permiso".
- La guía `docs/gmail-setup.md` se actualiza: añadir `https://mail.google.com/` en "Acceso a datos" de Google Cloud y volver a iniciar sesión. Explica que el permiso completo permite leer, enviar y borrar, y que el notch solo usa leer, marcar como leído y borrar.

## Ajustes

`settings.json` pasa a **versión 5** (migración 4 → 5):

```ts
gmail: {
  clientId: string
  clientSecret: string
  alerts: {
    enabled: boolean      // por defecto true
    hideContent: boolean  // por defecto false
    sound: boolean        // por defecto true
  }
}
```

Control Center → Gmail gana una sección **Avisos** con tres `Switch`; se guardan con `settings:update` y se aplican en la siguiente consulta.

## Arquitectura

### Main (`src/main/gmail/`)

- **`gmail-client.ts`** gana:
  - `message(id)`: `messages/{id}?format=full`, validado con zod → `GmailMessageDetail` (ver Modelo).
  - `markRead(id)`: `POST messages/{id}/modify` con `{ removeLabelIds: ['UNREAD'] }`.
  - `remove(id)`: `DELETE messages/{id}`.
  - Un **404** en `markRead` o `remove` cuenta como hecho (el correo ya no existe); en `message` → error `not-found`.
- **`message-text.ts`** (nuevo, puro):
  - Recorre las partes MIME (anidadas), decodifica **base64url** y el `charset` de la parte (UTF-8, ISO-8859-1/latin1, Windows-1252; otros → UTF-8 con sustitución).
  - Prefiere `text/plain`; si no hay, convierte `text/html` con `html-to-text` (sin imágenes, `<script>`/`<style>` descartados, párrafos y listas como saltos de línea, enlaces como `texto [n]`).
  - Extrae los enlaces **`http`/`https`** (de `href` en HTML o URLs en texto), sin duplicados, máximo **50**.
  - Recorta el cuerpo a **50 000** caracteres (`truncated: true`).
  - Cuenta los adjuntos (partes con `filename` no vacío).
- **`new-mail.ts`** (nuevo, puro): `createNewMailDetector()` → `{ observe(unreadIds: string[]): string[]; reset(): void }`.
  - La primera observación tras `reset()` solo guarda la referencia y devuelve `[]`.
  - Después devuelve los ids presentes ahora y ausentes en la observación anterior, en el orden de la lista (más reciente primero).
  - `reset()` se llama al iniciar o cerrar sesión, al cambiar de cliente y al reanudar tras una pausa (`mini`/`hidden`/`alert` de otro tipo durante ≥ 60 s).
- **`gmail-integration.ts`**:
  - `unreadCount()` pasa a devolver también los ids (ya los obtiene) para el detector.
  - Con ids nuevos y `alerts.enabled`: pide los metadatos del más reciente (como `recent()`), y emite **`gmail:new-mail`** `{ count, id, from?, subject? }` (sin `from`/`subject` si `hideContent`).
  - Tras `markRead` o `remove` correctos, consulta al momento (contador y lista).
  - Lleva un registro en memoria de los ids **mostrados** al notch (última lista + correo abierto + el del último aviso); `message`, `mark-read`, `delete` y `open-link` solo aceptan esos ids.
  - Guarda en memoria los enlaces del último correo abierto para `open-link`.
- **Sonido**: el mismo mecanismo que los recordatorios, si `alerts.sound`.

### Modelo

```ts
GmailMessageDetail = {
  id: string; threadId: string
  from: string            // nombre visible
  fromAddress: string     // dirección
  subject: string
  date: string            // ISO
  unread: boolean
  body: string            // texto plano, ≤ 50 000 caracteres
  truncated: boolean
  links: { text: string; url: string }[]   // http/https, ≤ 50
  attachments: number
}
GmailNewMail = { count: number; id: string; from?: string; subject?: string }
```

`GmailState` gana `reason: 'scope' | null` (para el texto de `expired`).

### IPC

Nuevos canales (todos con `registerIpc`, comprobación de sender y zod de entrada y salida):

| Canal / evento | Entrada | Salida | Quién |
|---|---|---|---|
| `gmail:message` | `{ id }` | `GmailMessageDetail` | **solo notch**; id mostrado |
| `gmail:mark-read` | `{ id }` | `null` | **solo notch**; id mostrado |
| `gmail:delete` | `{ id }` | `null` | **solo notch**; id mostrado |
| `gmail:open-link` | `{ id, index }` | `null` | **solo notch**; main abre `links[index]` del correo abierto con `shell.openExternal` |
| evento `gmail:new-mail` | — | `GmailNewMail` | main → notch |

`gmail:open { id? }` se mantiene ("Abrir en Gmail"). El renderer nunca envía una URL ni texto de correo a main.

### Notch

- **Modo y aviso**: el aviso de correo es un nuevo tipo de **`alert`** con la **prioridad más baja** (un permiso de Claude o un recordatorio se muestran antes y lo sustituyen). Dura **6 s** y se cierra solo; no se muestra si el panel está abierto (`expanded` o cualquier panel), y no hay consultas en `mini`/`hidden`. No roba el foco.
  - Contenido: icono `Mail` + "**Ana García** · Presupuesto del proyecto…" (recortado a una línea); con `hideContent` o sin datos, "**Correo nuevo**"; con `count > 1`, "**3 correos nuevos**".
  - Clic: abre la vista Gmail; si `count === 1`, directamente la lectura de ese correo.
  - Etiqueta accesible equivalente y `aria-live="polite"`.
- **Lista (vista "Gmail")**:
  - Clic/Enter en una fila **abre la lectura** (antes abría el navegador).
  - Acciones por fila, visibles con hover o foco (≥ 24 px): **Marcar como leído** (solo no leídos) y **Borrar**.
  - **Confirmación de borrar** en línea sustituyendo la fila: "¿Borrar para siempre? `Cancelar` `Borrar`", foco en Cancelar; Esc cancela.
  - Errores en línea en la fila ("No se pudo borrar · Reintentar").
- **Vista de lectura** (dentro del modo `gmail`; el panel cambia a su tamaño propio, ~**520×440**, fijado con capturas):
  - Cabecera: `←` (vuelve a la lista con el foco en la misma fila), remitente (nombre y dirección), asunto ("(sin asunto)"), fecha completa.
  - Cuerpo con desplazamiento, `white-space: pre-wrap`, Geist; si `truncated`, aviso "Correo recortado · Abrir en Gmail".
  - Enlaces: lista "Enlaces" bajo el cuerpo con el texto y la URL visible; clic → `gmail:open-link`.
  - "N adjuntos" si hay.
  - Pie: **Marcar como leído** (si no leído), **Borrar** (misma confirmación), **Abrir en Gmail**. Tras borrar, vuelve a la lista.
  - Estados: cargando, "Este correo ya no existe" (→ lista), error ("No se pudo cargar · Reintentar / Abrir en Gmail").
  - Teclado: Esc vuelve a la lista; otro Esc a la fila de integraciones.
- i18n ES/EN; tokens de `DESIGN.md`; el texto del correo siempre como texto.

### Control Center

Página Gmail: sección **Avisos** (activar, ocultar remitente y asunto, sonido) y el aviso de permiso insuficiente cuando `reason === 'scope'`.

## Seguridad y privacidad

1. El cuerpo del correo solo vive en memoria mientras se lee (main lo descarta al cerrar la lectura o al cerrar sesión); nunca se escribe en disco ni en el log, igual que asuntos, remitentes y enlaces.
2. Ningún HTML se pinta: la conversión ocurre en main y el renderer solo recibe texto.
3. `message`, `mark-read`, `delete` y `open-link` solo aceptan ids que main mostró al notch; `open-link` solo abre `http`/`https` de la lista que main extrajo de ese correo.
4. Borrar exige confirmación en la UI; main no confía en ella, pero solo borra ids mostrados.
5. El permiso completo se justifica solo por el borrado definitivo; el token sigue solo en main y cifrado con DPAPI.

## Coste

Igual que el hito 1 (una petición cada 60 s con la cápsula visible), más una petición de metadatos por cada consulta con correos nuevos, una al abrir un correo y una por acción.

## Pruebas

- **Unitarias**: `message-text` (solo texto, solo HTML, `multipart/alternative`, anidado, base64url, latin1, enlaces y su límite, recorte a 50 000, `<script>`/`<style>` descartados, adjuntos); `new-mail` (primera observación sin avisos, ids nuevos, ids que desaparecen, varios a la vez, `reset`); cliente (`message`, `markRead`, `remove`, 404 y 401); integración (aviso con y sin contenido, desactivado, varios, sin aviso en la primera consulta ni tras pausa, re-consulta tras acciones, ids no mostrados rechazados, `scope` insuficiente → `expired` con `reason`); ajustes v5 y migración 4 → 5; guards y contrato IPC; el log no contiene cuerpos ni enlaces.
- **E2E** con el servidor falso ampliado (`format=full`, `modify`, `DELETE`, añadir un correo nuevo): abrir un correo y ver su texto; abrir un enlace (URL capturada); marcar como leído (el contador baja); borrar con confirmación (desaparece y el servidor recibe `DELETE`); cancelar no borra; correo nuevo → aviso con contenido y con contenido oculto; capturas ES/EN de la lectura, la confirmación y el aviso.
- **Manual (usuario)**: volver a iniciar sesión con el permiso nuevo; borrar un correo de prueba real.

## Criterios de aceptación

1. Un correo de Principal se lee completo en el notch como texto, con sus enlaces abribles en el navegador.
2. Marcar como leído baja el contador en ≤ 2 s.
3. Borrar pide confirmación y elimina el correo para siempre; cancelar no hace nada.
4. Un correo nuevo muestra el aviso en la cápsula en ≤ 60 s, respetando los tres ajustes; nunca al arrancar ni al volver de una pausa.
5. Una sesión del hito 1 pide volver a iniciar sesión para el permiso nuevo.
6. Ningún cuerpo, enlace, asunto ni remitente aparece en el log ni en disco.

## Fuera de alcance

Archivar, destacar, mover a la papelera, responder, reenviar, descargar adjuntos, HTML con formato, imágenes, varias cuentas, toast de Windows para el correo, push/Pub/Sub.
