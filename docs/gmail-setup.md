# Configurar Gmail en Developer Notch

Developer Notch lee tu Gmail (solo lectura) con la API oficial de Google. Para eso necesita un **cliente OAuth propio**, creado en tu cuenta de Google Cloud. Es gratis y se hace una sola vez (unos 10 minutos).

Qué verás después: el número de correos sin leer de **Principal** en la cápsula y los 5 más recientes en la vista "Gmail" del notch. El permiso que se pide es `gmail.readonly`: el notch no puede enviar, borrar ni modificar nada.

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
4. Permisos (*Scopes* o *Acceso a los datos*): añade `https://www.googleapis.com/auth/gmail.readonly` ("Ver tus mensajes de correo y tu configuración"). Si no lo añades aquí, Google lo pedirá igualmente al iniciar sesión.
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
   - Acepta el permiso de solo lectura.
4. Cuando el navegador diga que ya puedes volver al notch, cierra la pestaña. Control Center mostrará **Conectado como tu@cuenta**.

Mientras esperas al navegador puedes pulsar **Cancelar**. Cambiar el ID de cliente cierra la sesión actual.

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
- Remitentes, asuntos y extractos solo viven en memoria: no se escriben en disco ni en el log.
- El notch consulta Gmail una vez por minuto mientras la cápsula está visible, y nada cuando está minimizada u oculta.

## Problemas frecuentes

| Qué ves | Qué pasa | Qué hacer |
|---|---|---|
| **Sin conexión** justo después de iniciar sesión, aunque tengas internet | La Gmail API no está habilitada en el proyecto (Google responde con un error de acceso) | Paso 2: habilítala en el mismo proyecto del cliente; el notch reintenta solo en unos minutos, o pulsa **Actualizar** en la vista |
| Google dice **"Acceso bloqueado"** o `access_denied` | Tu cuenta no está en **Usuarios de prueba** | Paso 3.3 |
| Google muestra `invalid_client` en el navegador, o Control Center dice **No se pudo iniciar sesión** | ID o secreto mal copiados, o el cliente no es de tipo **Aplicación de escritorio** | Pulsa **Cancelar** si sigue esperando, vuelve a cargar el JSON y repite; si el cliente es de otro tipo, crea uno de escritorio |
| **Vuelve a iniciar sesión** | La sesión caducó (7 días en Prueba) o revocaste el acceso | Pulsa **Iniciar sesión** en Control Center |
| **Configura Gmail en Control Center** | No hay cliente guardado | Paso 5 |
| La cápsula no muestra el número | No hay correos sin leer en Principal (con 0 no ocupa sitio) | Nada: es lo esperado |
