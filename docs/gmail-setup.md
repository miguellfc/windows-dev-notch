# Configurar Gmail en Developer Notch

Developer Notch muestra tu Gmail con la API oficial de Google. Para eso necesita un **cliente OAuth propio**, creado en tu cuenta de Google Cloud. Es gratis y se hace una sola vez (unos 10 minutos).

Qué verás después: el número de correos sin leer de **Principal** en la cápsula, los 5 más recientes en la vista "Gmail" del notch, la lectura de cada correo como texto, y un aviso breve en la cápsula cuando llega uno nuevo.

### El permiso que se pide

El notch pide el permiso completo de Gmail, `https://mail.google.com/`. Es el único con el que Google deja **borrar un correo para siempre**, y por eso es amplio: con él una aplicación podría **leer, enviar y borrar todo tu buzón**.

El notch solo usa tres cosas:

- **Leer** tus correos de Principal (el contador, la lista y la lectura de un correo).
- **Marcar como leído**, cuando pulsas el botón (abrir un correo no lo marca).
- **Borrar**, siempre después de confirmar "¿Borrar para siempre?". **El borrado es definitivo**: el correo no va a la papelera y no se puede recuperar.

Nunca envía, responde, archiva ni cambia nada más. El token queda solo en este equipo (ver **Privacidad**).

> La consola de Google cambia de vez en cuando los nombres de los menús. Si algo no coincide, busca el nombre entre paréntesis (el de la interfaz en inglés).

## 1. Crear un proyecto

1. Entra en <https://console.cloud.google.com/> con la cuenta de Gmail que quieres ver en el notch.
2. En el selector de proyectos (arriba a la izquierda) pulsa **Proyecto nuevo** (*New project*).
3. Ponle un nombre, por ejemplo `Developer Notch`, y pulsa **Crear**. Comprueba que queda seleccionado.

## 2. Habilitar la Gmail API

1. Menú **APIs y servicios → Biblioteca** (*APIs & Services → Library*).
2. Busca **Gmail API**, ábrela y pulsa **Habilitar** (*Enable*).

## 3. Pantalla de consentimiento

En **APIs y servicios → Pantalla de consentimiento de OAuth** (en la consola nueva: **Google Auth Platform**):

1. Rellena el nombre de la aplicación (por ejemplo `Developer Notch`) y tu correo como correo de asistencia y de contacto.
2. Tipo de usuario / Público (*Audience*): **Externo** (*External*).
3. **Usuarios de prueba** (*Test users*): pulsa **Añadir usuarios** y añade tu propia dirección de Gmail. Sin esto, Google rechaza el inicio de sesión.
4. **Acceso a datos** (*Data access* o *Scopes*): pulsa **Añadir o quitar permisos** (*Add or remove scopes*), escribe `https://mail.google.com/` en **Añadir permisos manualmente** (*Manually add scopes*), pulsa **Añadir a la tabla** y marca la fila. Google lo clasifica como permiso restringido y lo describe como acceso completo a tu correo (leer, redactar, enviar y eliminar definitivamente). Si no lo añades aquí, Google lo pedirá igualmente al iniciar sesión.
5. Guarda.

## 4. Crear el cliente OAuth

1. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth** (en la consola nueva: **Google Auth Platform → Clientes → Crear cliente**).
2. Tipo de aplicación: **Aplicación de escritorio** (*Desktop app*). Nombre: el que quieras.
3. Pulsa **Crear** y después **Descargar JSON**. Guarda el archivo en un sitio tuyo (no hace falta dejarlo junto al notch).

El ID de cliente acaba en `.apps.googleusercontent.com`; el secreto empieza por `GOCSPX-`. En un cliente de escritorio Google no considera el secreto confidencial, pero aun así no lo publiques.

## 5. Cargarlo en Developer Notch

1. Abre **Control Center → Gmail**.
2. Pulsa **Cargar archivo JSON** y elige el archivo descargado (el notch lee el ID y el secreto; el archivo no se copia). También puedes pegar el **ID de cliente** y el **Secreto de cliente** a mano y pulsar **Guardar**.
3. Pulsa **Iniciar sesión**. Se abre tu navegador predeterminado con la página de Google:
   - Elige tu cuenta.
   - Verás el aviso **"Google no ha verificado esta aplicación"**: es tu propia app. Pulsa **Continuar**.
   - Acepta el permiso de Gmail. Si Google muestra una casilla junto a él, márcala: sin ella el notch no recibe el permiso y te pedirá iniciar sesión de nuevo.
4. Cuando el navegador diga que ya puedes volver al notch, cierra la pestaña. Control Center mostrará **Conectado como tu@cuenta**.

Mientras esperas al navegador puedes pulsar **Cancelar**. Cambiar el ID de cliente cierra la sesión actual.

## Si ya usabas el notch con el permiso de solo lectura

Las versiones anteriores pedían `gmail.readonly`. Esa sesión ya no basta: el notch y Control Center muestran **"Vuelve a iniciar sesión para conceder el nuevo permiso"** y no consultan nada más hasta entonces.

1. En Google Cloud, **pantalla de consentimiento → Acceso a datos**, añade `https://mail.google.com/` como en el paso 3.4. Puedes quitar `https://www.googleapis.com/auth/gmail.readonly`: ya no se usa.
2. En **Control Center → Gmail**, pulsa **Iniciar sesión** y acepta el permiso (con su casilla marcada).

No hace falta crear otro cliente ni volver a cargar el JSON.

## Usar Gmail en el notch

- **Leer**: en la vista "Gmail", haz clic (o Enter) en un correo. Se muestra como texto plano, con sus enlaces debajo (se abren en tu navegador) y el número de adjuntos. **Abrir en Gmail** lo abre en el navegador. Esc vuelve a la lista.
- **Marcar como leído**: el botón de la fila (al pasar el ratón o con el foco) o el del pie de la lectura. El contador baja en un par de segundos.
- **Borrar**: el botón de la papelera pregunta **"¿Borrar para siempre?"**; **Cancelar** (o Esc) no hace nada y **Borrar** lo elimina de Gmail sin pasar por la papelera. No se puede deshacer.
- **Avisos de correo nuevo**: cuando llega un correo a Principal, la cápsula muestra unos segundos el remitente y el asunto (como mucho un minuto después). Un clic abre ese correo (o la lista, si llegaron varios). En **Control Center → Gmail → Avisos** puedes desactivarlos, ocultar remitente y asunto (el aviso dirá solo "Correo nuevo") o quitar el sonido. No aparecen con un panel del notch abierto.

## Caducidad semanal: "Prueba" frente a "En producción"

Con la pantalla de consentimiento en estado de publicación **Prueba** (*Testing*), Google caduca la sesión a los **7 días**. El notch lo detecta y muestra **"Vuelve a iniciar sesión"**: basta con pulsar **Iniciar sesión** otra vez en Control Center.

Para evitarlo puedes pasar la app a **En producción** (*In production*) sin verificarla (**Público → Publicar aplicación**). La sesión deja de caducar cada semana, a cambio de que Google muestre la pantalla de "aplicación no verificada" cada vez que inicies sesión. Google puede limitar las apps no verificadas que piden permisos de Gmail; para una sola cuenta, la tuya, funciona.

Las dos opciones son válidas: **la decisión es tuya**.

## Revocar el acceso

- Desde el notch: **Control Center → Gmail → Cerrar sesión** revoca el token y lo borra de este equipo.
- Desde Google, en cualquier momento: <https://myaccount.google.com/> → **Seguridad** → **Apps de terceros con acceso a la cuenta** (*Your connections to third-party apps & services*) → elige tu app → **Eliminar acceso**. El notch mostrará "Vuelve a iniciar sesión".
- Si ya no lo usas, puedes borrar el cliente o el proyecto entero en Google Cloud.

## Privacidad

- El token de sesión se guarda cifrado con el cifrado de Windows (DPAPI) en la carpeta de datos del notch y nunca sale de este equipo salvo hacia Google. Si Windows no puede cifrarlo, no se guarda y la sesión dura hasta cerrar el notch (Control Center lo avisa).
- Remitentes, asuntos, extractos, el texto de los correos y sus enlaces solo viven en memoria (el texto de un correo, mientras lo lees): no se escriben en disco ni en el log.
- El correo se muestra siempre como texto: el HTML se convierte en el proceso principal y nunca se pinta, ni se cargan imágenes.
- El notch consulta Gmail una vez por minuto mientras haya sesión, en cualquier modo (también con la cápsula minimizada u oculta, para que los avisos de correo nuevo lleguen siempre).

## Problemas frecuentes

| Qué ves | Qué pasa | Qué hacer |
|---|---|---|
| **Sin conexión** justo después de iniciar sesión, aunque tengas internet | La Gmail API no está habilitada en el proyecto (Google responde con un error de acceso) | Paso 2: habilítala en el mismo proyecto del cliente; el notch reintenta solo en unos minutos, o pulsa **Actualizar** en la vista |
| Google dice **"Acceso bloqueado"** o `access_denied` | Tu cuenta no está en **Usuarios de prueba** | Paso 3.3 |
| Google muestra `invalid_client` en el navegador, o Control Center dice **No se pudo iniciar sesión** | ID o secreto mal copiados, o el cliente no es de tipo **Aplicación de escritorio** | Pulsa **Cancelar** si sigue esperando, vuelve a cargar el JSON y repite; si el cliente es de otro tipo, crea uno de escritorio |
| **Vuelve a iniciar sesión** | La sesión caducó (7 días en Prueba) o revocaste el acceso | Pulsa **Iniciar sesión** en Control Center |
| **Vuelve a iniciar sesión para conceder el nuevo permiso** | La sesión es de una versión anterior (solo lectura), o al iniciar sesión no se concedió el permiso completo | Sección **Si ya usabas el notch con el permiso de solo lectura**: añade `https://mail.google.com/` en **Acceso a datos** y vuelve a iniciar sesión |
| **No concediste el permiso completo de Gmail** al iniciar sesión | Desmarcaste la casilla de Gmail en la pantalla de Google | Pulsa **Iniciar sesión** otra vez y deja la casilla marcada |
| **No se pudo borrar** o **No se pudo marcar** en una fila | Fallo de red o de Gmail en ese momento | Pulsa **Reintentar** (borrar vuelve a pedir confirmación) |
| **Este correo ya no existe** al abrir uno | Se borró o se movió desde otro dispositivo | Vuelve a la lista; se actualiza sola |
| **Configura Gmail en Control Center** | No hay cliente guardado | Paso 5 |
| La cápsula no muestra el número | No hay correos sin leer en Principal (con 0 no ocupa sitio) | Nada: es lo esperado |
