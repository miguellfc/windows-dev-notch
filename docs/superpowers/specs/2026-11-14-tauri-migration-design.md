# Migración de Developer Notch a Tauri 2

Fecha: 2026-11-14. Estado: borrador para aprobar.

## Intención

Developer Notch 0.1.0 es una app Electron 45 que está siempre abierta en Windows 11. La razón de migrar es **consumo y tamaño**: el instalador pesa 117 MB, la app ocupa 344 MB en disco y en reposo usa 301 MB de memoria privada. La migración pasa el proceso principal (hoy Node, `src/main`) a Rust con Tauri 2 y conserva la interfaz React (`src/renderer`) tal como está, ejecutándose en WebView2.

La prueba previa (`spikes/tauri-capsule/RESULTS.md`) midió lo que se puede esperar:

- **Tamaño:** el instalador de la cápsula mínima pesa 1,07 MB. Con la interfaz completa se espera entre 3 y 8 MB.
- **Memoria:** WebView2 gasta lo mismo que Electron con la misma página (138 frente a 130 MB). El ahorro viene de sustituir el proceso principal de Node (106 MB en la 0.1.0) por Rust. Se espera que la app completa quede entre 200 y 230 MB.
- **La ventana del notch es viable en Tauri:** transparente, siempre encima, sin robar el foco, con paso de clics y detección del puntero por sondeo del cursor.

## Objetivos

- Paridad funcional con la 0.1.0: todo lo que lista `CHANGELOG.md` para la 0.1.0 funciona igual en la versión Tauri, con la misma interfaz y los mismos textos en español e inglés.
- Instalador NSIS de **10 MB o menos**.
- Memoria privada en reposo de **230 MB o menos**, medida igual que en la prueba: árbol de procesos completo, notch en peek, Control Center cerrado y las integraciones configuradas como en el equipo de medición. Si no se alcanza, se informa con el desglose por proceso y no bloquea la entrega.
- La cápsula no roba nunca el foco. Solo el panel lo toma cuando necesita teclado.
- Primera versión Tauri publicada como **0.2.0**, sin funciones nuevas.

## No objetivos

- Funciones nuevas, rediseños o cambios de interfaz. El cronómetro de Redmine y el resto de pendientes siguen fuera.
- macOS y Linux.
- Migrar los datos de la 0.1.0. La versión Tauri empieza de cero: ajustes por defecto y las integraciones se configuran otra vez. Las notas y recordatorios de la 0.1.0 tampoco se trasladan.
- Reducir el proceso de GPU (134 MB en la 0.1.0). Es trabajo de interfaz y se hará aparte; vale para las dos versiones.

## Antiobjetivos

Sería un fracaso aunque funcionase:

- Que la cápsula robe el foco, desaparezca o deje de pasar los clics en algún momento (las dos trampas de la prueba).
- Que se rebajen las garantías de seguridad de la 0.1.0. Se mantienen:
  - Nunca se registran tokens, títulos de correos, PR, MR o tareas, ni el contenido de las preguntas de Claude.
  - Tokens y claves cifrados en reposo.
  - Redmine solo con `https`.
  - Los atajos de desarrollo por variable de entorno se ignoran en la versión publicada.
  - Los hooks de Claude solo se instalan tras confirmar, mostrando el diff y con copia de seguridad.
  - El servidor de hooks solo escucha en `127.0.0.1` y comprueba token y cabecera `Host`.
  - Las URL se abren solo tras comprobar su origen.
- Que la interfaz se bifurque en dos copias.

## Restricciones

- Solo Windows 11 con WebView2 Evergreen (viene con el sistema). El instalador no lleva WebView2 dentro.
- `src/renderer` se comparte entre las dos versiones durante la migración, y se cambia lo mínimo.
- Electron queda **congelada** mientras dura la migración: solo arreglos críticos en `dev`. Así cada cambio se hace una sola vez.
- La versión Tauri no se publica hasta tener paridad. Mientras tanto se usa solo en el equipo de desarrollo.
- Mismo repositorio. No se tocan `eslint.config.mjs` ni los hooks del repositorio.
- Nada de commits sin aprobación del usuario, ni push: el usuario abre los PR a `dev`.

## Enfoques considerados

1. **Tauri 2 con la interfaz React actual (elegido).** Se reescribe en Rust el proceso principal (unas 11.500 líneas en `src/main` y la parte de validación de `src/shared`), y la interfaz no cambia. Es el que consigue casi todo el ahorro posible por la mitad del trabajo.
2. **Rust también en la interfaz** (Slint, egui, iced o WinUI). Se descartó: obliga a rehacer el diseño y las animaciones, y es el que más riesgo tiene de empeorar la cápsula.
3. **Optimizar Electron sin migrar.** Se descartó como sustituto, porque no puede bajar el instalador de unos 100 MB. Lo de la GPU se hará aparte de todos modos.

Dentro del enfoque 1, se eligió **por partes con una sola entrega al final**, frente a publicar pronto con menos integraciones: nadie pierde Gmail, Redmine o las revisiones durante la migración.

## Decisiones

### Estructura

- Carpeta nueva `src-tauri/` con el crate de la app, al lado de `src/`. La configuración de Vite de la interfaz sirve para las dos versiones. El builder decide si hace falta una segunda configuración solo para Tauri.
- Se mantiene el identificador `dev.developernotch.app` de la 0.1.0 y el nombre de producto `Developer Notch`. Los datos de Tauri van en `%APPDATA%\dev.developernotch.app`, una carpeta distinta de la de Electron (`%APPDATA%\Developer Notch`), así que no se pisan. En el equipo de desarrollo las dos versiones pueden estar abiertas a la vez. Si pasa, sus cápsulas se solapan y las dos intentan registrar `Ctrl+Alt+Space`, así que hay que cerrar una. *(Decisión mía.)*
- **Actualizar desde la 0.1.0:** el instalador NSIS de la 0.2.0 detecta la 0.1.0 por su entrada de desinstalación (la de electron-builder), avisa y la desinstala antes de instalar, con un gancho NSIS de Tauri. Así no quedan dos apps arrancando con Windows. La carpeta de datos de la 0.1.0 no se borra. *(Decisión mía.)*
- El código Electron se queda hasta la parte 7, que lo retira.

### Puente con la interfaz

- La interfaz solo usa `window.notch`, construido con `buildApi(invoke, on)` desde `src/shared/ipc/build-api.ts`. En Tauri, un script de inicio construye el mismo objeto con `buildApi`, usando `invoke` y `listen` de Tauri. La interfaz no nota el cambio.
- Por defecto, un solo comando Tauri recibe `{ channel, input }` y despacha a la implementación de cada canal. Conserva las guardas actuales por ventana (qué canales puede llamar el notch y cuáles el Control Center). *(Decisión mía: con 96 canales, un comando por canal duplicaría el registro de permisos sin ganar seguridad, porque la guarda por ventana ya existe.)*
- Los eventos que hoy se emiten a la ventana (por ejemplo `notch:mode-changed` o `code-review:state`) se emiten con el mismo nombre a la etiqueta de ventana que corresponda.
- Los contratos zod de `src/shared/ipc/contract.ts` siguen mandando en TypeScript. En Rust, cada canal tiene sus tipos `serde`, que rechazan campos desconocidos como hacen hoy los esquemas estrictos. Una prueba de paridad pasa el mismo conjunto de ejemplos JSON por zod y por `serde` y exige el mismo resultado: aceptado o rechazado.
- El canal `notch:pointer` (la interfaz avisa de que el puntero está sobre la cápsula, gracias al reenvío de movimiento de Electron) se sustituye por el sondeo del cursor en Rust, como en la prueba: cada 33 ms, se activa o quita el paso de clics y se emite el evento. Es el único cambio previsto en la interfaz, además del script de arranque.

### Ventanas

- **Notch:** `transparent`, sin marco, `alwaysOnTop`, `skipTaskbar`, `shadow: false`, `focusable: false`. Se muestra siempre con `window.show()`, nunca con `ShowWindow` directo, porque tao guarda su propia marca de visibilidad y vuelve a ocultar la ventana en el siguiente cambio de estilo. Cuando el modo necesita teclado (panel, notas, búsqueda de Redmine, preguntas de Claude), se hace `set_focusable(true)` y se le da el foco. Al salir de ese modo se vuelve a `focusable: false`. El nivel de "siempre encima" tiene que quedar por encima de la barra de tareas, como hoy con `screen-saver`.
- **Control Center:** ventana normal con efecto Mica.
- **Geometría:** la de `src/shared/notch/geometry.ts`, sin cambios. Rust replica las constantes que necesita (ancho de ventana, alto por modo y rectángulo de la cápsula), y una prueba compara esos valores con los de TypeScript.

### Equivalencias por función

| 0.1.0 (Electron/Node) | Tauri/Rust |
|---|---|
| `net.fetch` (pila de red de Chromium) | `reqwest` con TLS del sistema (`native-tls`, Schannel) para usar el almacén de certificados de Windows |
| `safeStorage` | DPAPI (`CryptProtectData`) con el crate `windows` |
| `koffi` y llamadas Win32 | crate `windows` |
| `Notification` con clic | Notificación WinRT con evento de activación (crate `windows` o `tauri-winrt-notification`). El plugin de notificaciones de Tauri no da el clic en Windows. |
| `Tray` y menú | bandeja de Tauri (`tray-icon`) |
| `globalShortcut` | `tauri-plugin-global-shortcut` |
| Inicio con Windows | `tauri-plugin-autostart` |
| `shell.openExternal` | `tauri-plugin-opener`, tras la misma comprobación de origen |
| Instancia única | `tauri-plugin-single-instance` |
| `powerMonitor` (reanudar, desbloquear) | mensajes de energía y de sesión de Windows (`WM_POWERBROADCAST`, `WTSRegisterSessionNotification`) |
| Servidor HTTP de hooks (`node:http`) | `axum` o `hyper` solo en `127.0.0.1`, con el mismo formato de `bridge-config` |
| `html-to-text` (Gmail) | crate de HTML a texto. Resultado equivalente en los casos de prueba. |
| zod en el proceso principal | `serde` con rechazo de campos desconocidos |
| Reloj de pruebas y atajos `NOTCH_*` | los mismos nombres de variable, solo en compilaciones de desarrollo |
| `electron-builder` NSIS | bundler de Tauri, NSIS |

### Ajustes y datos

- El esquema de ajustes conserva la forma de la v7 que ve la interfaz, para que `src/renderer` no cambie. En Tauri empieza como v1 en su propio archivo y no lee el de la 0.1.0. Cada versión futura añade su migración, como hoy.
- Notas, recordatorios y tokens se guardan en la carpeta de datos nueva, con el mismo formato lógico que hoy donde la interfaz lo vea.

### Orden de las partes

Cada parte termina con la app Tauri arrancando y con sus pruebas pasando, y cada una es su propia rama y su propio PR a `dev`:

1. **Esqueleto:** crate, configuración, puente `window.notch`, las dos ventanas, la máquina de modos del notch, el sondeo del cursor y el cambio de monitor, la bandeja, el atajo global, la instancia única, los ajustes, i18n e idioma, y el registro local de uso.
2. **Sistema, notas, recordatorios y apertura de apps** (Claude Desktop, Windows Terminal): métricas, alertas por umbral, procesos, notificaciones con clic, y reanudar o desbloquear.
3. **Claude:** servidor de hooks, instalador de hooks con diff y copia, permisos, preguntas, sesiones y traer Claude al frente.
4. **GitHub y GitLab:** clientes, sondeo con espera progresiva, aviso de primera revisión y contribuciones.
5. **Redmine:** cliente, horas en la cápsula, resumen, tareas, aviso de fin de jornada.
6. **Gmail:** OAuth con cliente propio, lista, lectura como texto, marcar como leído, borrar y aviso de correo nuevo.
7. **Cierre:** instalador, inicio con Windows, medición final frente a los objetivos, documentación (`README.md`, `CHANGELOG.md` 0.2.0, guías en `docs/`, `THIRD_PARTY_NOTICES.md` con las licencias de los crates) y retirada de Electron (`src/main`, `src/preload`, `electron-builder.yml`, dependencias).

### Pruebas

- **Rust:** cada módulo porta el comportamiento que cubren hoy las pruebas unitarias de `tests/unit/main` (`cargo test`). `cargo clippy` sin avisos y `cargo fmt`.
- **Interfaz:** las pruebas de `tests/unit/renderer` y `tests/unit/shared` siguen como están (Vitest).
- **De extremo a extremo:** los escenarios de los 11 archivos de `tests/e2e` (de `app.spec.ts` a `system.spec.ts`) se portan a WebDriver con `tauri-driver` y `msedgedriver` de la misma versión que WebView2. Los servidores falsos de `tests/e2e/fixtures` (Redmine, revisiones, Gmail) se reutilizan. Cada parte porta los escenarios de lo que migra.
- **Capa de control solo para pruebas.** Hoy las pruebas e2e usan `app.evaluate` de Electron para leer la geometría y el foco de las ventanas, el área de trabajo, el PID, espiar `shell.openExternal`, mover el reloj de pruebas y leer el portapapeles. El puntero lo simulan llamando a `notch:pointer`. En Tauri, todo eso va en un módulo de Rust que solo se compila con la feature de cargo `e2e`. Esa feature no está nunca en el instalador publicado y las pruebas e2e se ejecutan contra la compilación `e2e`. Con ella, `notch:pointer` se conserva como forma de inyectar el puntero y una variable desactiva el sondeo del cursor real, para que el puntero del usuario no cambie el modo a mitad de prueba. *(Decisión mía: es lo que ya hacen `NOTCH_TEST_CLOCK` y los demás atajos, llevado a tiempo de compilación.)*
- Se mantienen las reglas de la 0.1.0: no se controla el escritorio del usuario (solo capturas de las ventanas de la app) y no se cierran procesos que no lanzaron las pruebas.

## Riesgos conocidos

- **Red:** el usuario confirma que no usa proxy. GitHub, GitLab y Gmail van con conexión directa, y Redmine va a través de la VPN del equipo. La VPN funciona al nivel del sistema y no necesita nada de la app, así que se usa `reqwest` sin soporte de proxy. Si Redmine falla con la VPN desconectada, debe dar el mismo estado sin conexión que en la 0.1.0. Esto se comprueba en la parte 5.
- **Notificaciones con clic:** las notificaciones WinRT necesitan un AppUserModelID registrado. En desarrollo, sin acceso directo instalado, puede que no funcionen igual. Hay que probarlas al principio de la parte 2.
- **Hooks de Claude mientras conviven las dos versiones:** las dos marcan sus hooks con la misma cabecera `x-notch-hook: 1`. Instalar los hooks desde Tauri sustituye los de la 0.1.0 (con el diff a la vista, como siempre), y desinstalar desde una versión quita los de la otra. Se acepta que solo una versión tenga los hooks a la vez: en el desarrollo se sabe cuál está activa, y en la actualización a la 0.2.0 sustituirlos es justo lo que se quiere. *(Decisión mía.)*
- **Paso de foco al panel:** cambiar `focusable` en caliente no se probó. Hay que validarlo en la parte 1, antes de seguir.
- **Paridad de contratos:** 96 canales mantenidos a mano en dos lenguajes. La prueba de paridad es la defensa.

## Lo que queda al builder

- Las librerías concretas, cuando la tabla da dos opciones o ninguna.
- La organización interna del crate en módulos.
- Cómo comparte Vite la configuración entre las dos versiones.
- El formato de los ejemplos de la prueba de paridad.
- Cómo se ejecutan las pruebas de extremo a extremo en local.
