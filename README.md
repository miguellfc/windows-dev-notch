# Developer Notch

Cápsula flotante para Windows 11, inspirada en Dynamic Island, pensada para desarrolladores. Vive arriba al centro de la pantalla, no roba el foco y muestra solo lo que necesita atención ahora: sesiones de Claude Code que esperan permiso, recordatorios, correo sin leer, revisiones de PR/MR y horas de Redmine. Permite actuar con una o dos pulsaciones sin salir de la app actual. Está hecha con Tauri 2 (proceso principal en Rust) y una interfaz en React, TypeScript y Tailwind que se ejecuta en WebView2.

## Funciones

- Cápsula con modos peek (hora y fecha), compacta, alerta, panel expandido, mini y oculta.
- Estado de Claude Code, con permisos y preguntas respondibles desde el notch.
- Monitor del sistema con alertas por umbral.
- Recordatorios y notas rápidas.
- Gmail: [docs/gmail-setup.md](docs/gmail-setup.md).
- GitHub y GitLab (PR/MR y contribuciones): [docs/code-review-setup.md](docs/code-review-setup.md).
- Redmine (tareas y horas): [docs/redmine-setup.md](docs/redmine-setup.md).
- Control Center para la configuración, español e inglés.

## Requisitos

- Windows 11.
- Microsoft Edge WebView2 Runtime (Evergreen). Viene con Windows 11; si faltara, el instalador lo descarga.
- Para desarrollar:
  - Node.js 22.12 o superior.
  - Rust estable con la toolchain MSVC (`x86_64-pc-windows-msvc`) y las herramientas de compilación de C++ de Visual Studio, como pide Tauri.
  - Para las pruebas de extremo a extremo, `tauri-driver` y `msedgedriver`: [docs/e2e.md](docs/e2e.md).

## Instalación

Genera el instalador con `npm run build`. Queda en `src-tauri/target/release/bundle/nsis/Developer Notch_<versión>_x64-setup.exe`. Ejecútalo para instalar la app: se instala solo para tu usuario, sin permisos de administrador, en `%LOCALAPPDATA%\Developer Notch`.

### Actualizar desde la 0.1.0

- El instalador de la 0.2.0 detecta la 0.1.0, avisa y la desinstala antes de instalar. Si la 0.1.0 estaba instalada para todos los usuarios, pide permisos de administrador; si cancelas el aviso, la instalación se detiene.
- Los datos de la 0.1.0 (`%APPDATA%\Developer Notch`) se conservan, pero la 0.2.0 no los lee: empieza con los ajustes por defecto en `%APPDATA%\dev.developernotch.app`. Las notas y los recordatorios de la 0.1.0 no se trasladan.
- Hay que volver a configurar las integraciones (Gmail, GitHub, GitLab y Redmine) desde el Control Center, y volver a activar el inicio con Windows si lo usabas.
- Hay que reinstalar los hooks de Claude Code desde el Control Center. Los de la 0.1.0 siguen en `~/.claude/settings.json` apuntando a un puente que ya no existe; la instalación los sustituye, mostrando el diff antes de confirmar.

Los cambios y las diferencias conocidas de la 0.2.0 están en [CHANGELOG.md](CHANGELOG.md).

## Desarrollo

```
npm install
npm run dev          # arranca la app en modo desarrollo (tauri dev)
npm run build        # compila y genera el instalador NSIS (tauri build)
npm run typecheck
npm run lint
npm test             # pruebas unitarias de la interfaz y lo compartido (Vitest)
npm run test:rust    # pruebas de Rust (cargo test), incluida la paridad de contratos
npm run test:e2e     # compila la app con la feature e2e y ejecuta WebdriverIO
npm run notices      # regenera THIRD_PARTY_NOTICES.md
```

`npm run test:e2e` necesita `tauri-driver` y `msedgedriver` de la misma versión que WebView2; todo está en [docs/e2e.md](docs/e2e.md). En Rust, los gates habituales son `cargo fmt --check` y `cargo clippy --all-targets -- -D warnings`, con y sin `--features e2e`, dentro de `src-tauri`.

## Configuración

Se hace desde el Control Center (menú de la bandeja o icono de la cabecera del panel). El atajo global para abrir el panel es `Ctrl+Alt+Space` por defecto y se puede cambiar allí. Las integraciones externas se conectan con las guías de arriba; los ajustes y los tokens se guardan en local, y los tokens se cifran con DPAPI de Windows.

## Estructura

- `src-tauri`: la app de Tauri en Rust (ventanas, bandeja, atajo, integraciones, canales IPC), su configuración, los permisos y el gancho del instalador (`windows/hooks.nsh`).
- `src/tauri-bridge`: el script que construye `window.notch` para la interfaz con `invoke` y `listen` de Tauri.
- `src/renderer`: interfaces React (`notch`, `control-center`, `shared`, `ui`, `styles`).
- `src/shared`: esquemas, tipos, contrato IPC e i18n compartidos.
- `tests`: pruebas unitarias (`unit`), de extremo a extremo (`e2e-tauri`) y los ejemplos de paridad entre zod y serde (`parity`). Las pruebas de Rust viven junto a cada módulo y en `src-tauri/tests`.
- `scripts`: utilidades del repositorio (`typecheck.mjs`, `third-party-notices.mjs`) y `measure-idle.ps1` (medición en reposo de la app instalada).
- `docs`: guías de configuración, pruebas de extremo a extremo, specs y planes. Contexto de producto en `PRODUCT.md` y diseño en `DESIGN.md`.

## Licencia

Aún no se declara ninguna licencia. Los avisos de software de terceros (crates de Rust, paquetes npm, fuentes e iconos) están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), generado con `npm run notices`.

## Cambios

Consulta [CHANGELOG.md](CHANGELOG.md).
