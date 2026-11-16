# Pruebas de extremo a extremo de la versión Tauri

`tests/e2e-tauri/` prueba la app de Tauri entera con WebdriverIO: arranca el ejecutable, maneja sus dos webviews (la cápsula y el Control Center) y comprueba ventanas, modos, ajustes, el registro de uso, el monitor del sistema, las notas, los recordatorios, las baldosas de Claude y Terminal y la integración con Claude Code (sesiones, permisos, preguntas e instalación de hooks). Son las mismas situaciones que los archivos del mismo nombre en `tests/e2e/` prueban en Electron:

| Archivo | Pruebas |
|---|---|
| `app.spec.ts` | 11 (parte 1) |
| `system.spec.ts` | 5 |
| `system-alerts.spec.ts` | 1 |
| `notes.spec.ts` | 1 |
| `reminders.spec.ts` | 5 |
| `apps.spec.ts` | 5 |
| `claude.spec.ts` | 8 (parte 3) |
| `claude-questions.spec.ts` | 8 (parte 3) |

Lo que no se puede portar tal cual lleva un comentario `GAP:` en la prueba.

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
npm run test:e2e:tauri
```

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
- `files`: archivos (un objeto se escribe como JSON; un texto, tal cual) que se escriben en la carpeta de datos antes de arrancar (`settings.json`, `reminders.json`), como los `writeSettings` y `writeReminders` de Electron. Los ajustes se escriben en la versión actual: el almacén de Rust no migra versiones antiguas (las pone en cuarentena), así que la versión 3 que escribe Electron no serviría.

Interruptores que usan las pruebas de la parte 2:

- `NOTCH_APP_LAUNCH_LOG=1` (`apps.spec.ts`): las baldosas de Claude y Terminal anotan lo que lanzarían en lugar de lanzarlo. Ninguna prueba abre Claude Desktop, el navegador ni una terminal; `apps.spec.ts` comprueba que la anotación está activa antes de hacer clic.
- `NOTCH_APP_LAUNCH_FAIL=claude` o `terminal`: con el anterior, el lanzamiento de esa app falla.

Interruptores de la parte 3 (Claude Code). `wdio.conf.mts` los pone también en el entorno base, así que ninguna app de la ejecución toca el `~/.claude/settings.json` real ni ocupa un puerto fijo:

- `NOTCH_CLAUDE_SETTINGS`: el `settings.json` de Claude. Siempre es `claude-settings.json` dentro de la carpeta temporal de la ejecución. `claude.spec.ts`, `claude-questions.spec.ts` y la prueba de sesiones de `apps.spec.ts` lo pasan en cada arranque (`claudeEnv()` de `helpers.ts`) y fallan antes de arrancar si la ruta queda fuera de esa carpeta temporal. Además, siembran el archivo con una marca aleatoria (o con su propio contenido) y comprueban que la vista previa de la instalación la muestra antes de confirmar: así se sabe que la app lee ese archivo antes de que escriba nada.
- `NOTCH_CLAUDE_PORT=0`: el puente HTTP escucha en un puerto efímero de `127.0.0.1`.
- `NOTCH_DISABLE_CLAUDE_FOCUS=1`: «Responder en Claude» no trae al frente la ventana real de Claude (solo anota `disabled` en el registro).

Las pruebas de Claude instalan los hooks desde el Control Center, como lo haría el usuario, leen la URL y el token del `settings.json` temporal y envían los hooks desde el proceso de la prueba con `http` de Node (solo a `127.0.0.1`). Los registros se leen de `<datos>/logs/main.log` y sus rotaciones (`readLogs()`). Ninguna prueba arranca Claude Code ni Claude Desktop.

### Canales de prueba

Además de los de la parte 1 (`window-bounds`, `foreground-is-ours`, `advance-clock`, `pointer`, `mail-alert`, `shortcut`, `work-area`, `pid`, `quit`):

- `__e2e:app-launches`: lo que anotó `NOTCH_APP_LAUNCH_LOG=1` (`{ launches, home }`, con la carpeta de usuario en la que se abre la terminal). Sin el interruptor responde `UNAVAILABLE`.
- `__e2e:clipboard`: sin entrada lee el texto del portapapeles del sistema (`null` si no hay texto); con `{ text }` lo escribe. La prueba de notas guarda el portapapeles del usuario y lo deja como estaba.
- `__e2e:process-cpu`: tiempo de CPU acumulado (milisegundos, usuario más núcleo) del árbol de procesos de la app, con los de WebView2: `{ cpuMs, processes, perProcess }`. La prueba de coste en reposo lo lee cada 5 s y lo pasa a la misma unidad que `percentCPUUsage` de Electron, que es una parte de la máquina entera (un núcleo ocupado da 100 entre los procesadores lógicos, 6,25 % con 16), y registra también el porcentaje de un núcleo.
- `__e2e:advance-clock` adelanta también el reloj de pared y los temporizadores de los recordatorios, y responde cuando ha terminado la comprobación de recordatorios.

Las variables de entorno solo se respetan en compilaciones de depuración o con la feature `e2e`. Los canales `__e2e:*` (`src-tauri/src/e2e.rs`) solo existen con la feature `e2e`. No forman parte del contrato de la interfaz (`tests/parity/channels.json`), y una compilación de `release` no los contiene, como comprueba `test_channels_exist_only_in_the_e2e_build`. Las pruebas los llaman desde cualquiera de las dos ventanas con `window.__TAURI_INTERNALS__.invoke('notch_ipc', { channel: '__e2e:…', input })`.

Mientras corren las pruebas, la cápsula aparece y desaparece en lo alto de la pantalla. Es mejor no usar el ordenador mientras tanto (unos 3 min y medio con las 44 pruebas). La prueba de cerrar un proceso lanza un `node -e "for(;;){}"` propio que ocupa un núcleo y lo cierra desde la interfaz; si la prueba falla antes, lo cierra ella misma.
