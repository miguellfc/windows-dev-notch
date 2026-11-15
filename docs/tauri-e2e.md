# Pruebas de extremo a extremo de la versión Tauri

`tests/e2e-tauri/app.spec.ts` prueba la app de Tauri entera con WebdriverIO: arranca el ejecutable, maneja sus dos webviews (la cápsula y el Control Center) y comprueba ventanas, modos, ajustes y el registro de uso. Son las mismas situaciones que `tests/e2e/app.spec.ts` prueba en Electron.

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

Para ejecutar solo algunas, se filtran por nombre: `--mochaOpts.grep "Control Center"`.

## Cómo se aíslan

- Cada prueba arranca su propia app, con una carpeta de datos temporal y vacía (`NOTCH_USER_DATA_DIR`). La carpeta se borra al final. Si se indica una carpeta propia con `NOTCH_E2E_DATA_DIR`, se usa tal cual y no se borra (aunque cada prueba la vacía). Nunca toca los datos reales ni la Developer Notch instalada.
- `NOTCH_DISABLE_FOREGROUND_WATCH=1`: la cápsula no depende de la ventana que esté delante.
- `NOTCH_DISABLE_CURSOR_POLL=1`: el cursor real no cambia el modo durante la prueba. El paso del puntero se simula con el canal `__e2e:pointer`.
- `NOTCH_TEST_CLOCK=1`: los temporizadores de la cápsula siguen un reloj de prueba que `__e2e:advance-clock` adelanta.
- El atajo global se simula con `__e2e:shortcut`. No se pulsan teclas reales ni se mueve el ratón. Los clics y las teclas de WebDriver solo llegan a la página.

Las variables de entorno solo se respetan en compilaciones de depuración o con la feature `e2e`. Los canales `__e2e:*` (`src-tauri/src/e2e.rs`) solo existen con la feature `e2e`. No forman parte del contrato de la interfaz (`tests/parity/channels.json`), y una compilación de `release` no los contiene, como comprueba `test_channels_exist_only_in_the_e2e_build`. Las pruebas los llaman desde cualquiera de las dos ventanas con `window.__TAURI_INTERNALS__.invoke('notch_ipc', { channel: '__e2e:…', input })`.

Mientras corren las pruebas, la cápsula aparece y desaparece en lo alto de la pantalla. Es mejor no usar el ordenador durante unos 20 s.
