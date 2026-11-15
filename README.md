# Developer Notch

Cápsula flotante para Windows 11, inspirada en Dynamic Island, pensada para desarrolladores. Vive arriba al centro de la pantalla, no roba el foco y muestra solo lo que necesita atención ahora: sesiones de Claude Code que esperan permiso, recordatorios, correo sin leer, revisiones de PR/MR y horas de Redmine. Permite actuar con una o dos pulsaciones sin salir de la app actual. Está hecha con Electron, React, TypeScript y Tailwind.

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
- Para desarrollar: Node.js 22.12 o superior.

## Instalación

Genera el instalador NSIS con `npm run dist`; queda en `dist/`. Ejecútalo para instalar la app.

## Desarrollo

```
npm install
npm run dev          # arranca la app en modo desarrollo
npm run typecheck
npm run lint
npm test             # pruebas unitarias (Vitest)
npm run test:e2e     # compila y ejecuta Playwright
npm run dist         # compila y genera el instalador
```

## Configuración

Se hace desde el Control Center (menú de la bandeja o icono de la cabecera del panel). El atajo global para abrir el panel es `Ctrl+Alt+Space` por defecto y se puede cambiar allí. Las integraciones externas se conectan con las guías de arriba; los ajustes y los tokens se guardan en local, y los tokens se cifran con `safeStorage` de Windows.

## Estructura

- `src/main`: proceso principal (ventanas, bandeja, atajo, integraciones, IPC).
- `src/preload`: puente seguro entre main y renderer.
- `src/renderer`: interfaces React (`notch`, `control-center`, `shared`, `ui`, `styles`).
- `src/shared`: esquemas, tipos, contrato IPC e i18n compartidos.
- `tests`: pruebas unitarias (`unit`) y end-to-end (`e2e`).
- `docs`: guías de configuración, specs y planes. Contexto de producto en `PRODUCT.md` y diseño en `DESIGN.md`.

## Licencia

Aún no se declara ninguna licencia. Los avisos de software de terceros están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Cambios

Consulta [CHANGELOG.md](CHANGELOG.md).
