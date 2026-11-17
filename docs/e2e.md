# Pruebas de extremo a extremo

`tests/e2e-tauri/` prueba la app entera con WebdriverIO: arranca el ejecutable, maneja sus dos webviews (la cápsula y el Control Center) y comprueba ventanas, modos, ajustes, el registro de uso, el monitor del sistema, las notas, los recordatorios, las baldosas de Claude y Terminal, la integración con Claude Code (sesiones, permisos, preguntas e instalación de hooks), las revisiones de código de GitHub y GitLab, Redmine y Gmail. Son 61 pruebas en 11 archivos:

| Archivo | Pruebas |
|---|---|
| `app.spec.ts` | 11 |
| `system.spec.ts` | 5 |
| `system-alerts.spec.ts` | 1 |
| `notes.spec.ts` | 1 |
| `reminders.spec.ts` | 5 |
| `apps.spec.ts` | 5 |
| `claude.spec.ts` | 8 |
| `claude-questions.spec.ts` | 8 |
| `code-review.spec.ts` | 5 |
| `redmine.spec.ts` | 3 |
| `gmail.spec.ts` | 9 |

Lo que una prueba no puede comprobar tal cual lleva un comentario `GAP:` que lo explica.

## Qué hace falta

Solo en Windows. WebdriverIO habla con `tauri-driver`, y este con `msedgedriver`, el driver de WebView2.

1. **tauri-driver**, con Cargo:

   ```sh
   cargo install tauri-driver --locked
   ```

   Queda en `%USERPROFILE%\.cargo\bin\tauri-driver.exe`. Otra ruta se indica con la variable `TAURI_DRIVER`.

2. **msedgedriver** de la misma versión que el runtime de WebView2 instalado. Si las versiones no coinciden, la sesión no arranca.
   - La versión de WebView2 aparece en *Configuración › Aplicaciones › Aplicaciones instaladas › Microsoft Edge WebView2 Runtime*. También se puede consultar con PowerShell:

     ```powershell
     (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv
     ```

   - Se descarga la misma versión desde la página oficial de Microsoft Edge WebDriver (`developer.microsoft.com/microsoft-edge/tools/webdriver`), en x64.
   - Se deja en `%LOCALAPPDATA%\Programs\msedgedriver\msedgedriver.exe`. Otra ruta se indica con la variable `NOTCH_MSEDGEDRIVER`.
   - Cuando Windows actualice WebView2, hay que actualizar también `msedgedriver`.

3. Las dependencias de npm del proyecto (`npm install`). Ya incluyen WebdriverIO.

## Cómo se ejecutan

```sh
npm run test:e2e
```

(`npm run test:e2e:tauri` es un alias del mismo script.)

El script hace dos pasos:

1. Compila la app en modo depuración con la feature `e2e` y la interfaz empaquetada, sin servidor de desarrollo ni instalador: `tauri build --debug --no-bundle --features e2e`. El resultado es `src-tauri/target/debug/developer-notch.exe`.
2. Lanza `wdio run tests/e2e-tauri/wdio.conf.mts`. Esta configuración arranca `tauri-driver` en el puerto 4746 y `msedgedriver` en el 9746. Al acabar, los cierra.

Para repetir las pruebas sin volver a compilar:

```sh
npx wdio run tests/e2e-tauri/wdio.conf.mts
```

Para ejecutar solo algunas, se elige el archivo con `--spec tests/e2e-tauri/notes.spec.ts` o se filtran por nombre: `--mochaOpts.grep "Control Center"`.

Para probar otro ejecutable compilado con la feature `e2e` (por ejemplo uno de `release`: `tauri build --no-bundle --features e2e`), se indica su ruta en `NOTCH_E2E_APP`.

## Cómo se aíslan

- Cada prueba arranca su propia app, con una carpeta de datos temporal y vacía (`NOTCH_USER_DATA_DIR`). La carpeta se borra al final. Si se indica una carpeta propia con `NOTCH_E2E_DATA_DIR`, se usa tal cual y no se borra (aunque cada prueba la vacía). Nunca toca los datos reales ni la Developer Notch instalada.
- `NOTCH_DISABLE_FOREGROUND_WATCH=1`: la cápsula no depende de la ventana que esté delante.
- `NOTCH_DISABLE_CURSOR_POLL=1`: el cursor real no cambia el modo durante la prueba. El paso del puntero se simula con el canal `__e2e:pointer`.
- `NOTCH_TEST_CLOCK=1`: los temporizadores de la cápsula y de los recordatorios siguen un reloj de prueba que `__e2e:advance-clock` adelanta (también el reloj de pared); la llamada responde cuando ha terminado la comprobación de recordatorios que fuerza.
- El atajo global se simula con `__e2e:shortcut`. No se pulsan teclas reales ni se mueve el ratón. Los clics y las teclas de WebDriver solo llegan a la página. Ojo: en la compilación `e2e` los eventos del puntero virtual de WebDriver sobre la cápsula sí llegan al controlador como paso del puntero; si una prueba necesita la cápsula en reposo después de hacer clic, llama antes a `__e2e:pointer` con `{ inside: false }`.

### Entorno propio de cada prueba

`tauri-driver` pasa a todas las apps que arranca el mismo entorno, el de su arranque. Una prueba que necesita sus propios interruptores los pasa al arrancar la app con `launch({ fresh, env, files })` (`helpers.ts`):

- `env`: variables `NOTCH_*` solo para esa app. Viajan como argumentos `--e2e-env-NOMBRE=valor` en `tauri:options.args`, y la compilación `e2e` los aplica al entorno antes de leer nada (`e2e::apply_cli_env`). Va un argumento por variable porque `msedgedriver` los trata como opciones de Chromium: guarda un solo valor por nombre y puede pasar el nombre a minúsculas, así que la app lo vuelve a poner en mayúsculas.
- `files`: archivos (un objeto se escribe como JSON; un texto, tal cual) que se escriben en la carpeta de datos antes de arrancar (`settings.json`, `reminders.json`). Los ajustes se escriben en la versión actual: el almacén no migra versiones antiguas (las pone en cuarentena).

Interruptores de las baldosas de Claude y Terminal:

- `NOTCH_APP_LAUNCH_LOG=1` (`apps.spec.ts`): las baldosas de Claude y Terminal anotan lo que lanzarían en lugar de lanzarlo. Ninguna prueba abre Claude Desktop, el navegador ni una terminal; `apps.spec.ts` comprueba que la anotación está activa antes de hacer clic.
- `NOTCH_APP_LAUNCH_FAIL=claude` o `terminal`: con el anterior, el lanzamiento de esa app falla.

Interruptores de Claude Code. `wdio.conf.mts` los pone también en el entorno base, así que ninguna app de la ejecución toca el `~/.claude/settings.json` real ni ocupa un puerto fijo:

- `NOTCH_CLAUDE_SETTINGS`: el `settings.json` de Claude. Siempre es `claude-settings.json` dentro de la carpeta temporal de la ejecución. `claude.spec.ts`, `claude-questions.spec.ts` y la prueba de sesiones de `apps.spec.ts` lo pasan en cada arranque (`claudeEnv()` de `helpers.ts`) y fallan antes de arrancar si la ruta queda fuera de esa carpeta temporal. Además, siembran el archivo con una marca aleatoria (o con su propio contenido) y comprueban que la vista previa de la instalación la muestra antes de confirmar: así se sabe que la app lee ese archivo antes de que escriba nada.
- `NOTCH_CLAUDE_PORT=0`: el puente HTTP escucha en un puerto efímero de `127.0.0.1`.
- `NOTCH_DISABLE_CLAUDE_FOCUS=1`: «Responder en Claude» no trae al frente la ventana real de Claude (solo anota `disabled` en el registro).

Las pruebas de Claude instalan los hooks desde el Control Center, como lo haría el usuario, leen la URL y el token del `settings.json` temporal y envían los hooks desde el proceso de la prueba con `http` de Node (solo a `127.0.0.1`). Los registros se leen de `<datos>/logs/main.log` y sus rotaciones (`readLogs()`). Ninguna prueba arranca Claude Code ni Claude Desktop.

Interruptores de las revisiones de código. `wdio.conf.mts` también pone los dos en el entorno base:

- `NOTCH_CODE_REVIEW_BASE_URLS=github=http://127.0.0.1:<puerto>,gitlab=http://127.0.0.1:<puerto>`: la API de GitHub y el servidor de GitLab pasan a ser un servidor local. En el entorno base apuntan los dos al puerto 9 de `127.0.0.1`, donde no escucha nadie, así que ninguna app de la ejecución puede llegar a los GitHub o GitLab reales. `code-review.spec.ts` pasa en cada arranque el servidor falso de `tests/e2e-tauri/fixtures/fake-code-review.ts`, que arranca en el propio proceso de la prueba. Los ajustes siguen guardando la URL https de GitLab (`https://gitlab.example.test`). Ojo: si el valor está mal formado, la app desactiva el interruptor entero y hablaría con los servidores reales. La protección es `start()` de `code-review.spec.ts`: antes de arrancar la app comprueba con una expresión regular que la base del servidor falso es exactamente `http://127.0.0.1:<puerto>` y arma el valor a partir de ella. Que el servidor falso reciba las peticiones y no registre violaciones del protocolo solo lo confirma después.
- `NOTCH_OPEN_URL_LOG=1`: las URL que la app abriría en el navegador se anotan en orden y no se abren. Ninguna prueba abre el navegador; `code-review.spec.ts` comprueba que la anotación está activa antes de hacer clic en una fila.

Las pruebas usan solo los tokens falsos del servidor de prueba, nunca los del usuario. Guardan los tokens desde el Control Center, como el usuario, y comprueban al final que ningún token aparece en el DOM de las dos ventanas ni en claro en la carpeta de datos, y que ningún token, título, rama, autor ni cuenta aparece en los registros. Los ritmos de 120 s y 15 min se adelantan con `__e2e:advance-clock`; las consultas que dispara se hacen después de que el canal responda, así que la prueba espera sus efectos con `eventually`. Los temporizadores de la cápsula corren sobre el tiempo real en la compilación `e2e` y además vencen antes si el reloj de prueba pasa su hora: el aviso de primera revisión acaba a los 6 s de tiempo real o cuando el reloj de prueba pasa ese punto, lo que llegue antes. La prueba no mueve el reloj mientras el aviso está a la vista y comprueba que acaba solo en tiempo real (más de 4 s, menos de 12 s).

Reintento al abrir el panel (pendiente conocido): con el Control Center abierto, el panel puede perder el foco unos 30 ms después de abrirse (visto en 2 de 4 ejecuciones con WebDriver), y entonces se cierra (`Focused(false)` → `Dismiss`). En las ejecuciones e2e, cada pérdida de foco con el panel abierto fue a una ventana de otra app (la barra de tareas, la terminal, ventanas emergentes), así que cerrar el panel es lo correcto. Cada pérdida queda anotada en la línea de depuración `notch: focus lost (...)` de `%APPDATA%\dev.developernotch.app\logs\main.log`. Queda pendiente comprobarlo con entrada real. Como medida de las pruebas, `expandPanel()` de `code-review.spec.ts` vuelve a abrir el panel (hasta 3 veces) solo cuando el registro del controlador muestra un `Dismiss` desde el panel abierto que la prueba no envió; cualquier otro fallo al abrirlo falla en el acto. Cada reintento se anota en la salida, y al final se anota cuántos hubo.

Zona horaria (diferencia conocida de la 0.2.0, anotada en `CHANGELOG.md`; se corregirá después): la parte de Rust (`chrono::Local`) toma las medianoches locales de las reglas de zona de Windows, mientras que la interfaz de WebView2 (`Date` de JavaScript) y Node usan los datos de ICU. Para algunas zonas y años no coinciden, y entonces, dentro de la app, el proceso principal y la interfaz no están de acuerdo en el día local durante una hora al día. No es un fallo de la prueba: es una diferencia conocida que queda anotada. Como medida de las pruebas, cuando Node no coincide con Windows y Windows usa un mismo desfase entero en todos los días que pueden pedirse, `code-review.spec.ts` pone su proceso en ese desfase fijo (`Etc/GMT±H`, `alignZoneWithWindows()` de `helpers.ts`) y lo anota en la salida; si no puede leer los desfases de Windows, también lo anota. Así el servidor falso comprueba los rangos de contribuciones con los días de la app. Los datos esperados se calculan con el día de Windows. Solo en la hora de la divergencia conocida (la prueba tuvo que alinear la zona, el día de la interfaz es el de ICU en la zona original del proceso y está exactamente a un día del de Windows) se salta lo que depende del «hoy» de la interfaz (el anillo de hoy, la parada del tabulador y la línea del día, la etiqueta del día de hoy y la del gráfico) y lo anota; cualquier otra diferencia entre los dos días hace fallar la prueba. No cambia nada de la app ni de sus webviews.

Interruptores de Redmine. `wdio.conf.mts` también pone `NOTCH_REDMINE_BASE_URL` en el entorno base:

- `NOTCH_REDMINE_BASE_URL=http://127.0.0.1:<puerto>`: la API REST de Redmine pasa a ser un servidor local. En el entorno base apunta al puerto 9 de `127.0.0.1`, donde no escucha nadie, así que ninguna app de la ejecución puede llegar a un Redmine real. `redmine.spec.ts` pasa en cada arranque el servidor falso de `tests/e2e-tauri/fixtures/fake-redmine.ts`, que arranca en el propio proceso de la prueba. Los ajustes siguen guardando la URL https que se escribe en el Control Center (`https://redmine.example.test`), y «Abrir en Redmine» anota esa URL, nunca la del servidor falso. La app solo acepta exactamente `http://127.0.0.1:<puerto>`; cualquier otro valor desactiva el interruptor y la app hablaría con el servidor de los ajustes. Por eso `start()` de `redmine.spec.ts` comprueba con una expresión regular, antes de arrancar la app, que la base del servidor falso tiene esa forma.
- `NOTCH_OPEN_URL_LOG=1`, como en las revisiones de código: `redmine.spec.ts` comprueba que la anotación está activa antes de hacer clic en nada.

Las pruebas usan solo la clave falsa del servidor de prueba, nunca la del usuario. La guardan desde el Control Center, como el usuario (`redmine.bin`, cifrado con DPAPI, en la carpeta temporal). Las tres comprueban al final que la clave no aparece en claro en la carpeta de datos y que ninguna clave, asunto, proyecto, comentario, cuenta ni servidor aparece en los registros; solo la primera comprueba además que la clave no aparece en el DOM de las dos ventanas. El servidor falso es estricto (cabeceras, consultas, cuerpos) y cada prueba comprueba que no registró ninguna violación del protocolo.

El sondeo de 5 min y la comprobación de fin de jornada se mueven con `__e2e:advance-clock`. La prueba del aviso de fin de jornada salta el reloj de prueba al siguiente lunes a las 18:00:30 (hora de Windows), espera a que la consulta que dispara el salto lea las horas de ese día y vuelve a llamar a `advance-clock` con 0 ms, que ejecuta la comprobación. El aviso dura 6 s de tiempo real (o hasta que el reloj de prueba pasa ese punto); la prueba hace clic en él enseguida y no mueve el reloj mientras está a la vista.

La diferencia de zona horaria también afecta a Redmine: el «hoy» de las horas, el resumen, el fin de jornada y la regla de «la fecha no puede ser futura» se calculan en Rust con las reglas de Windows, y la fecha que la interfaz propone al imputar sale de ICU. `redmine.spec.ts` alinea su proceso con Windows igual que `code-review.spec.ts`, pero mirando también la semana siguiente (`alignZoneWithWindows(9)`), porque la prueba del aviso salta hasta el próximo lunes. Así el servidor falso siembra y comprueba sus días con los de la app, y los datos esperados se calculan con el día de Windows. Solo en la hora de la diferencia conocida (las mismas tres condiciones de `appDays`) acepta que la fecha propuesta sea el «hoy» de la interfaz en lugar del de Windows, y lo anota. En ese caso imputa en el más temprano de los dos días, porque la app rechaza el posterior como fecha futura, y las horas esperadas del resumen y de la cápsula siguen al día imputado. Cualquier otra diferencia entre los dos días hace fallar la prueba. El panel se abre con el mismo reintento ante una pérdida de foco que `code-review.spec.ts`.

Interruptores de Gmail. `wdio.conf.mts` también pone `NOTCH_GMAIL_BASE_URL` y `NOTCH_GMAIL_CLIENT_FILE` en el entorno base:

- `NOTCH_GMAIL_BASE_URL=http://127.0.0.1:<puerto>`: Google entero (la pantalla de consentimiento `/o/oauth2/v2/auth`, `/token`, `/revoke` y la API de Gmail) pasa a ser un servidor local. En el entorno base apunta al puerto 9 de `127.0.0.1`, donde no escucha nadie, así que ninguna app de la ejecución puede llegar a Google. `gmail.spec.ts` pasa en cada arranque el servidor falso de `tests/e2e-tauri/fixtures/fake-gmail.ts`, que arranca en el propio proceso de la prueba y hace de Google con rigor (PKCE, `redirect_uri` local, alcance, portador en cada llamada). La app solo acepta exactamente `http://127.0.0.1:<puerto>`, sin ruta; cualquier otro valor desactiva el interruptor y la app hablaría con Google. Por eso `start()` de `gmail.spec.ts` comprueba con una expresión regular, antes de arrancar la app, que la base del servidor falso tiene esa forma.
- `NOTCH_GMAIL_CLIENT_FILE=<ruta>`: «Cargar archivo JSON» del Control Center lee esa ruta en lugar de abrir el diálogo de Windows (el límite de 64 KiB, la lectura y el análisis siguen siendo los de verdad). En el entorno base apunta a un archivo que no existe dentro de la carpeta temporal, así que una pulsación suelta responde «El archivo no es un cliente de escritorio de Google» sin abrir ningún diálogo. Si `msedgedriver` descartara la opción de un arranque, la app heredaría esa ruta del entorno base, nunca el diálogo. Nunca se usa el valor vacío: el selector lo lee como «Cancelar». La prueba sin cliente comprueba esa respuesta con su propia ruta, que tampoco existe. `gmail.spec.ts` pasa en cada arranque `gmail-client.json` de la carpeta temporal, con el cliente falso, y falla antes de arrancar si la ruta queda fuera de esa carpeta.
- `NOTCH_OPEN_URL_LOG=1`, como en las revisiones de código y Redmine: la pantalla de consentimiento, los hilos de Gmail y los enlaces de un correo se anotan y no se abren. `gmail.spec.ts` comprueba que la anotación está activa antes de hacer clic en nada, y al final que solo se «abrieron» la pantalla de consentimiento, Gmail y los enlaces que extrajo la app.

La prueba hace de navegador para iniciar sesión: pulsa «Iniciar sesión» en el Control Center, lee la URL de consentimiento con `__e2e:opened-urls`, la pide al servidor falso desde Node sin seguir redirecciones y llama a la dirección `http://127.0.0.1:<puerto>/callback?code&state` que devuelve, que es el servidor local de la app. Ninguna prueba siembra un token: la sesión siempre sale del flujo OAuth contra el servidor falso. El cliente falso se escribe en el Control Center y se guarda (y se carga del archivo) en la primera prueba; las demás lo siembran en `settings.json`. Solo el token de renovación se guarda, cifrado con DPAPI, en `gmail-token.bin`.

Las pruebas usan solo el cliente, la cuenta y los correos falsos del servidor de prueba. Al final comprueban que ningún token emitido, el secreto del cliente, la cuenta, la dirección del servidor falso ni ningún dato de correo (remitente, dirección, asunto, fragmento, líneas del cuerpo, enlaces, adjuntos) aparece en los registros; que ningún token ni dato de correo aparece en claro en la carpeta de datos; que ningún token aparece en el DOM de las dos ventanas (ni el secreto en la cápsula; el Control Center lo muestra en su campo de contraseña), y que el servidor falso no registró ninguna violación del protocolo.

El sondeo de 60 s y la hora del token de acceso se mueven con `__e2e:advance-clock`; el sondeo que dispara corre después de que el canal responda, así que la prueba espera sus efectos con `eventually`. El aviso de correo nuevo dura 6 s de tiempo real (o hasta que el reloj de prueba pasa ese punto); la prueba no mueve el reloj mientras está a la vista y comprueba que acaba solo, entre 4 y 9 s. La espera de 300 s del retorno de OAuth corre siempre en tiempo real. El panel se abre con el mismo reintento ante una pérdida de foco que `code-review.spec.ts`.

Gmail no usa fechas locales en el proceso principal: la cabecera `Date` del servidor falso va en GMT y la app solo la pasa a una fecha ISO en UTC (la interfaz la formatea), así que la diferencia de zona horaria no le afecta y `gmail.spec.ts` no alinea la zona.

### Canales de prueba

Además de los básicos (`window-bounds`, `foreground-is-ours`, `advance-clock`, `pointer`, `mail-alert`, `shortcut`, `work-area`, `pid`, `quit`):

- `__e2e:app-launches`: lo que anotó `NOTCH_APP_LAUNCH_LOG=1` (`{ launches, home }`, con la carpeta de usuario en la que se abre la terminal). Sin el interruptor responde `UNAVAILABLE`.
- `__e2e:clipboard`: sin entrada lee el texto del portapapeles del sistema (`null` si no hay texto); con `{ text }` lo escribe. La prueba de notas guarda el portapapeles del usuario y lo deja como estaba.
- `__e2e:process-cpu`: tiempo de CPU acumulado (milisegundos, usuario más núcleo) del árbol de procesos de la app, con los de WebView2: `{ cpuMs, processes, perProcess }`. La prueba de coste en reposo lo lee cada 5 s y lo pasa a una parte de la máquina entera (un núcleo ocupado da 100 entre los procesadores lógicos, 6,25 % con 16), y registra también el porcentaje de un núcleo.
- `__e2e:opened-urls`: las URL que anotó `NOTCH_OPEN_URL_LOG=1`, en orden (`string[]`). Sin el interruptor responde `UNAVAILABLE`.
- `__e2e:advance-clock` adelanta también el reloj de pared, los temporizadores de los recordatorios, los de las revisiones de código (las consultas de 120 s, las esperas tras un fallo y las contribuciones cada 15 min) y los de Redmine (la consulta de 5 min, las esperas tras un fallo, el resumen cada 15 min con la vista abierta y el temporizador y el intervalo de 60 s del fin de jornada) y los de Gmail (el recuento de 60 s y las esperas tras un fallo; el reloj de pared mueve también la caducidad del token y el mínimo de 5 s entre actualizaciones manuales). Después ejecuta la comprobación de fin de jornada y la de recordatorios, y responde cuando han terminado.

Las variables de entorno solo se respetan en compilaciones de depuración o con la feature `e2e`. Los canales `__e2e:*` (`src-tauri/src/e2e.rs`) solo existen con la feature `e2e`. No forman parte del contrato de la interfaz (`tests/parity/channels.json`), y una compilación de `release` no los contiene, como comprueba `test_channels_exist_only_in_the_e2e_build`. Las pruebas los llaman desde cualquiera de las dos ventanas con `window.__TAURI_INTERNALS__.invoke('notch_ipc', { channel: '__e2e:…', input })`.

Mientras corren las pruebas, la cápsula aparece y desaparece en lo alto de la pantalla. Es mejor no usar el ordenador mientras tanto (unos 4 min y medio con las 61 pruebas). La prueba de cerrar un proceso lanza un `node -e "for(;;){}"` propio que ocupa un núcleo y lo cierra desde la interfaz; si la prueba falla antes, lo cierra ella misma.
