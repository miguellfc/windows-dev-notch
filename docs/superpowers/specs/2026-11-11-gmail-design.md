# Gmail en el notch — Hito 1: base — Diseño

**Fecha:** 2026-11-11 · **Rama:** `feat/gmail` (desde `dev`)
**Fuentes:** PRD ("Cambio de dirección: integraciones vivas"), `DESIGN.md`, patrón de las integraciones del notch (recordatorios, sistema, notas).

## Objetivo

Saber de un vistazo cuántos correos sin leer hay en **Principal** y ver los más recientes desde el notch, sin abrir Gmail; abrir uno en el navegador con un clic.

## Alcance y división (decidido con el usuario)

Gmail se divide en tres hitos, en este orden. Este documento cubre solo el **hito 1**.

1. **Base** (este spec): inicio de sesión con Google, contador de sin leer en la cápsula, vista con los 5 más recientes y abrir en el navegador. Solo lectura.
2. **Leer y actuar**: leer un correo dentro del notch (HTML saneado, sin imágenes remotas) y acciones rápidas (marcar leído, archivar, destacar). Pide `gmail.modify`. Spec propio.
3. **Avisos**: aviso de correo nuevo en la cápsula. Spec propio.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Conexión | **Gmail API + OAuth** (cliente "Escritorio" en un proyecto de Google Cloud del usuario). Descartado IMAP con contraseña de aplicación (acceso completo al buzón, desaconsejado por Google, bloqueado en algunas cuentas) |
| Cuentas | **Una** cuenta |
| Qué correos | Solo la pestaña **Principal** de la bandeja de entrada (`in:inbox category:primary`) |
| Lista | Los **5** correos más recientes |
| Permiso | `gmail.readonly` en este hito; `gmail.modify` llega en el hito 2 (un nuevo consentimiento) |
| SDK | Ninguno: `fetch` desde main contra la API REST, respuestas validadas con zod (sin `googleapis`) |

## Configuración por el usuario

Guía paso a paso en `docs/gmail-setup.md`: crear el proyecto en Google Cloud, habilitar la Gmail API, configurar la pantalla de consentimiento (tipo externo, el usuario como usuario de prueba), crear un cliente OAuth "Aplicación de escritorio" y descargar su JSON.

Limitación conocida: con la pantalla de consentimiento en modo **Testing**, Google caduca el token de refresco a los **7 días**; el notch lo detecta y pide volver a iniciar sesión. Pasarla a **En producción** sin verificar evita la caducidad semanal a cambio del aviso "app no verificada" al iniciar sesión. La guía explica ambas opciones; la decisión es del usuario.

## Arquitectura

### Main (`src/main/gmail/`)

- **`gmail-auth.ts`**: inicio de sesión OAuth 2.0 para apps instaladas.
  - Genera `code_verifier` / `code_challenge` (S256) y un `state` aleatorio.
  - Abre un servidor HTTP de un solo uso en `127.0.0.1` con puerto aleatorio (`redirect_uri = http://127.0.0.1:<puerto>`) y abre la URL de autorización en el **navegador predeterminado** con `shell.openExternal` (nunca dentro de Electron).
  - El servidor acepta solo `GET` a la ruta de retorno con `state` coincidente, responde una página mínima ("Ya puedes volver al notch") y se cierra al recibir el código, con un error o a los **5 min**.
  - Cambia el código por tokens (`oauth2.googleapis.com/token`), refresca el token de acceso y revoca (`oauth2.googleapis.com/revoke`) al cerrar sesión.
  - Obtiene la dirección de la cuenta con `users/me/profile` (para mostrarla en Control Center).
  - Reloj, `fetch` y `openExternal` inyectados.
- **`token-store.ts`**: guarda el token de refresco cifrado con `safeStorage.encryptString` en `userData/gmail-token.bin` (escritura atómica). Si `safeStorage.isEncryptionAvailable()` es falso, no persiste nada: la sesión dura lo que dure la app y Control Center lo indica. El token de acceso vive solo en memoria.
- **`gmail-client.ts`**:
  - `unreadCount()`: `users/me/messages?q=in:inbox category:primary is:unread&maxResults=100` y cuenta los ids (100 o más se muestra como `99+`).
  - `recent()`: `users/me/messages?q=in:inbox category:primary&maxResults=5` y después `messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date` por cada id → `{ id, threadId, from, subject, snippet, date, unread }`. El remitente se reduce al nombre visible (o la dirección si no hay nombre).
  - Ante un **401** refresca el token una vez y repite; si vuelve a fallar → `expired`.
  - Toda respuesta se valida con zod; una respuesta inválida se descarta y se registra solo el código.
  - Las URLs base de la API y de OAuth son inyectables (en E2E apuntan a un servidor falso; en producción son fijas).
- **`gmail-integration.ts`**: puerta `ready` como las demás integraciones; crea auth, store y cliente; mantiene el estado y emite eventos.
  - **Ritmo**: `unreadCount()` cada **60 s** mientras la cápsula está visible (`compact`, `peek`, panel abierto); nada en `mini` ni `hidden`. Con la vista abierta, además `recent()` al abrirla y en cada tick.
  - `gmail:refresh` consulta al momento (con un mínimo de 5 s entre consultas manuales).
  - **Errores de red, 5xx o 429**: estado `offline` conservando los últimos datos; reintento con espera creciente (1 → 2 → 4 → 5 min máx.) y vuelta al ritmo normal al primer éxito.
  - Al reanudar tras `mini`/`hidden` consulta al momento.

### Ajustes

`settings.json` pasa a **versión 4** (migración 3 → 4):

```ts
gmail: {
  clientId: string      // '' = sin configurar
  clientSecret: string  // el de un cliente "Escritorio" (Google no lo considera confidencial)
}
```

Se guardan desde Control Center con `settings:update`. Ni el secreto ni los tokens se escriben nunca en el log. Cambiar el `clientId` cierra la sesión actual.

### Modelo de estado

```ts
GmailState = {
  status: 'unconfigured' | 'signed-out' | 'signing-in' | 'ok' | 'offline' | 'expired'
  account: string | null       // dirección de la cuenta conectada
  unread: number | null        // 0–100 (100 = "99+")
  updatedAt: string | null     // ISO de la última consulta correcta
}
GmailMessage = { id: string; threadId: string; from: string; subject: string; snippet: string; date: string; unread: boolean }
```

### IPC

| Canal / evento | Entrada | Salida | Quién |
|---|---|---|---|
| evento `gmail:state` | — | `GmailState` | main → notch y Control Center |
| `gmail:get-state` | — | `GmailState` | notch y Control Center |
| `gmail:recent` | — | `GmailMessage[]` (máx. 5) | **solo notch** |
| `gmail:view` | `{ open: boolean }` | `null` | **solo notch** |
| `gmail:refresh` | — | `null` | **solo notch** |
| `gmail:open` | `{ id?: string }` | `null` | **solo notch**; main construye la URL |
| `gmail:sign-in` | — | `'ok' \| 'cancelled' \| 'error'` | **solo Control Center** |
| `gmail:cancel-sign-in` | — | `null` | **solo Control Center** |
| `gmail:sign-out` | — | `null` | **solo Control Center** |

Todo pasa por `registerIpc` (comprobación de sender, zod de entrada y salida). `gmail:open` solo acepta un `id` de la última lista enviada y abre `https://mail.google.com/mail/u/0/#inbox/<threadId>` (o `#inbox` sin id); el renderer nunca envía una URL.

### Notch

- **Integración** `gmail` en `src/shared/integrations/registry.ts` (después de Notas, icono Lucide `Mail`), modo y vista `gmail` en `PANEL_MODES`.
- **Fila de integraciones**: 5 casillas. Se mide con Playwright en ES/EN que cabe en el panel de 440 px (con 4 la fila termina en x = 507 y el borde está en 596); si no cabe, se ajusta el ancho mínimo de las casillas.
- **Cápsula compacta**: con `status` `ok` u `offline` y `unread > 0`, un bloque `Mail` + cifra (`3`, `99+`) en Grafito Cristal, tabular, después de las métricas. Sin sesión, con 0 o sin datos no ocupa sitio. Aparece y desaparece con el **latch** de 3 lecturas de la cápsula. Etiqueta accesible: "3 correos sin leer" / "3 unread emails".
  - Anchos: se añaden a `COMPACT_WIDTHS` las variantes con correo, medidas en ES/EN con el peor caso (`99+` con disco y batería); el cambio de ancho usa el fundido existente.
- **Vista "Gmail"** (`src/renderer/notch/gmail/`), **420 px de ancho** y alto medido con 5 filas (sin hueco ni scroll; se fija con capturas):
  - Cabecera: `←`, "Gmail", el número de sin leer y botón **Actualizar** (icono `RefreshCw`, ≥ 24 px).
  - Lista de 5 filas: remitente y hace cuánto llegó en la primera línea, asunto en la segunda, extracto recortado a una línea; los no leídos en negrita con un punto azul hielo. Clic o Enter abre el correo en el navegador.
  - Pie: enlace "Abrir Gmail".
  - Estados: sin configurar ("Configura Gmail en Control Center" + botón que abre esa página), sin sesión ("Inicia sesión en Control Center"), caducada ("Vuelve a iniciar sesión" + botón a Control Center), sin conexión (últimos datos atenuados + "Actualizado hace 3 min"), vacío ("No hay correos en Principal"), cargando (filas esqueleto, sin animación con `prefers-reduced-motion`).
  - Teclado completo: flechas entre filas, Enter abre, Esc vuelve a la fila de integraciones.
- i18n ES/EN; tokens de `DESIGN.md`; el texto de los correos se pinta siempre como texto (nunca HTML).

### Control Center

- **Nueva página "Gmail"** (icono `Mail`, después de Sistema):
  - Campos ID de cliente y secreto, o botón **Cargar archivo JSON** (lee `installed.client_id` / `installed.client_secret` del JSON de Google, validado con zod; el archivo no se copia).
  - Botón **Iniciar sesión** (deshabilitado sin configurar; "Esperando al navegador…" mientras `signing-in`, con **Cancelar**) y, con sesión, la cuenta conectada y **Cerrar sesión**.
  - Aviso si la sesión ha caducado y, si `safeStorage` no está disponible, que la sesión no se recordará al reiniciar.
  - Texto breve con los pasos de configuración y la ruta de la guía `docs/gmail-setup.md`.

## Seguridad y privacidad

1. El token de refresco solo existe en main y en disco cifrado con DPAPI (`safeStorage`); nunca se envía a un renderer ni se registra.
2. El inicio de sesión ocurre en el navegador del sistema; el servidor de retorno escucha solo en `127.0.0.1`, exige `state` coincidente y PKCE S256, y vive como mucho 5 min.
3. Remitentes, asuntos y extractos solo están en memoria; nunca se escriben en disco ni en el log (el log solo lleva estados, recuentos y códigos de error).
4. `gmail:recent`, `gmail:open`, `gmail:view` y `gmail:refresh` solo desde el notch; `gmail:sign-in`, `gmail:cancel-sign-in` y `gmail:sign-out` solo desde Control Center; entradas y salidas validadas con zod.
5. Las URLs que se abren las construye main a partir de ids de la última lista.
6. Permiso mínimo: `gmail.readonly` en este hito.

## Coste

Una petición cada 60 s con la cápsula visible (el contador) y, con la vista abierta, 1 + 5 peticiones más por tick. Muy por debajo de la cuota gratuita de la Gmail API. Sin trabajo en `mini`/`hidden`.

## Pruebas

- **Unitarias**: PKCE (verifier/challenge S256) y `state`; servidor de retorno (rechaza `state` distinto y métodos o rutas ajenas; se cierra al recibir el código, con error y a los 5 min); cambio de código y refresco; 401 → refresco una vez → `expired`; red caída → `offline` con datos conservados y espera creciente; esquemas zod (respuestas de Gmail, JSON del cliente, ajustes v4 y migración 3 → 4); `token-store` (cifrado disponible o no); ritmo de 60 s, pausa y consulta al reanudar con temporizadores falsos; mínimo de 5 s en `refresh`; `gmail:open` con id fuera de la lista rechazado; guards IPC; latch y anchos de la cápsula; estado y geometría del modo `gmail`.
- **E2E** con un **servidor falso de Gmail y OAuth** local (URL base por variable de entorno, solo en tests) y un token sembrado: cifra en la cápsula, vista con 5 correos, abrir uno (se intercepta `openExternal`), sesión caducada (el servidor responde 401) y estado sin configurar; capturas ES/EN de la cápsula, la vista y la página de Control Center.
- **Manual (usuario)**: el inicio de sesión real con su cuenta y la guía de configuración.

## Criterios de aceptación

1. Con la guía, el usuario configura el cliente e inicia sesión desde Control Center sin tocar archivos.
2. La cápsula muestra el número de sin leer de Principal y se actualiza en ≤ 60 s; con 0 no ocupa sitio.
3. La vista "Gmail" muestra los 5 correos más recientes de Principal y abre cualquiera en el navegador.
4. Una sesión caducada o revocada se muestra como "Vuelve a iniciar sesión", nunca como un fallo silencioso.
5. Ningún token, remitente, asunto ni extracto aparece en el log ni en disco sin cifrar.
6. En `mini`/`hidden` no se hace ninguna petición.

## Fuera de alcance (de este hito)

Leer el contenido de un correo y acciones (hito 2); avisos de correo nuevo (hito 3); varias cuentas; otras pestañas o etiquetas; enviar o responder; Pub/Sub o push.
