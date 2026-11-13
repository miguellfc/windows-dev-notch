# Configurar GitHub y GitLab en Developer Notch

Developer Notch muestra tus PR de **GitHub** (github.com) y tus MR de un **GitLab propio** con **tokens personales de solo lectura**. Se configuran una vez, en unos minutos.

Qué verás después: en la cápsula, por plataforma, cuántos PR/MR tuyos abiertos siguen **sin revisar**; un aviso breve cuando uno recibe su primera revisión (**Aprobado**, **Cambios pedidos** o **Revisado**); y en la vista "Revisiones" del notch, lo que **espera tu revisión** y **lo tuyo abierto**, con su estado. Un clic abre cada uno en el navegador.

El notch **solo lee**: nunca aprueba, comenta, fusiona ni cambia nada.

## 1. GitHub

### Recomendado: token detallado (*fine-grained*) de solo lectura

1. En GitHub, abre tu foto → **Settings → Developer settings → Personal access tokens → Fine-grained tokens** y pulsa **Generate new token**.
2. Ponle un nombre (por ejemplo `Developer Notch`) y una caducidad.
3. **Resource owner**: tu usuario o la organización de los repositorios.
4. **Repository access**: **Only select repositories** y elige los repositorios que quieres ver.
5. **Permissions → Repository permissions**, todo en **Read-only**:
   - **Pull requests**
   - **Metadata** (GitHub lo marca solo)
   - **Commit statuses** (los tokens detallados no tienen permiso *Checks*; si los checks no aparecen, usa el token clásico)
6. Pulsa **Generate token** y copia el token (GitHub solo lo enseña una vez).

Ten en cuenta:

- El token **solo ve los repositorios que elegiste**: un PR de otro repositorio no aparecerá.
- En una **organización**, el token puede quedar **pendiente de aprobación** por un administrador; hasta entonces no ve sus repositorios.

### Alternativa: token clásico

**Personal access tokens → Tokens (classic) → Generate new token (classic)** con el permiso **`repo`**. Ve todos tus repositorios sin elegirlos uno a uno, pero **también permite escribir** en ellos (el notch no lo hace, pero el token lo permitiría). Úsalo solo si el detallado no te sirve.

## 2. GitLab

1. Necesitas la **URL de tu servidor**, siempre con `https://` (por ejemplo `https://gitlab.tuempresa.com`). Las direcciones `http://` se rechazan.
2. En GitLab, abre tu avatar → **Edit profile → Access → Personal access tokens**.
3. Abre el desplegable **Generate token** y elige **Legacy token** (el token clásico). El formulario que sale por defecto es el nuevo *Fine-grained token*, que no tiene `read_api`.
4. Ponle un nombre (por ejemplo "Developer Notch") y una caducidad, y marca **solo** el permiso **`read_api`**.
5. Crea el token y cópialo.

**Si no aparece "Legacy token"**: tu administrador de GitLab ha activado *Require fine-grained personal access tokens* (o tu GitLab es 19.2 o posterior con esa política). Entonces elige **Fine-grained token**:

- **Acceso a grupos y proyectos**: todos los grupos y proyectos de los que eres miembro, o solo los que quieras ver.
- **Permisos, solo lectura (Read)**: **Merge Request** (lista de MR, aprobaciones y revisores) y **User** (para identificar tu cuenta).
- Al pulsar **Comprobar y guardar**, el notch te dirá enseguida si el token sirve; si muestra "Token no válido o sin permisos", revisa esos permisos o pide a tu administrador un token clásico.

Los tokens detallados existen en beta desde GitLab 18.10 y son estables desde la 19.2.

## 3. Pegarlo en el notch

1. Abre **Control Center → GitHub y GitLab**.
2. **GitHub**: pega el token en **Token de GitHub** y pulsa **Comprobar y guardar**.
3. **GitLab**: escribe la **URL de GitLab**, pega el token en **Token de GitLab** y pulsa **Comprobar y guardar**.
4. Si todo va bien verás **Conectado como** *tu cuenta*, y el campo del token se vacía. En unos segundos aparecen los contadores en la cápsula.

En la misma página puedes activar o quitar los **avisos** y su **sonido** por plataforma.

## Caducidad y "Revisa el token"

Los tokens caducan cuando tú decidiste al crearlos (o cuando los revocas). Si GitHub o GitLab dejan de aceptarlo, el notch lo dice como **"Revisa el token"** en la vista y en Control Center, y **deja de consultar** esa plataforma hasta que guardes uno nuevo. Crea otro token con los mismos permisos y vuelve a pulsar **Comprobar y guardar**.

## Quitar o revocar un token

- En el notch: **Control Center → GitHub y GitLab → Quitar** borra el token de este equipo.
- En el servidor (para invalidarlo del todo):
  - GitHub: **Settings → Developer settings → Personal access tokens**, abre el token y pulsa **Delete** (o **Revoke**).
  - GitLab: **Edit profile → Access → Personal access tokens**, pulsa **Revoke** en la fila del token.

## Privacidad

- Los tokens se guardan **solo en este equipo**, cifrados con el cifrado de Windows (DPAPI). Si el equipo no puede cifrar, el token vive solo en memoria y habrá que pegarlo de nuevo tras reiniciar (Control Center lo avisa).
- Los tokens solo se envían a `api.github.com` y al servidor de GitLab que configuraste.
- Títulos, repositorios y autores solo se tienen en memoria: nunca se escriben en disco ni en el registro.

## Problemas frecuentes

| Qué ves | Qué pasa | Qué hacer |
|---|---|---|
| "Token no válido o sin permisos" al guardar | Token mal copiado, caducado o sin los permisos de lectura | Copia el token entero o crea uno nuevo con los permisos de arriba |
| "La URL debe empezar por https://" | La URL de GitLab usa `http://` o tiene usuario, `?` o `#` | Escribe solo la dirección del servidor con `https://` |
| "Sin conexión con GitHub/GitLab" | No hay red, el servidor no responde o la URL no es de un GitLab | Comprueba la red y la URL; el notch reintenta solo |
| "Revisa el token" | El token caducó o se revocó | Crea otro y pulsa **Comprobar y guardar** |
| Falta un PR o un repositorio | El token detallado no incluye ese repositorio, o la organización aún no lo aprobó | Edita el token y añade el repositorio, o pide la aprobación |
| La cápsula no muestra el bloque | No tienes PR/MR propios abiertos sin revisar (los borradores no cuentan) | Es lo esperado; la vista "Revisiones" sigue listando todo |
| Un aviso tarda | El notch consulta cada 2 minutos | Espera o pulsa **Actualizar** en la vista |
