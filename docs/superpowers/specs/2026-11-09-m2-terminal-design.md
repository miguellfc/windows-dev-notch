# M2 · Integraciones + terminal PowerShell — Diseño

**Fecha:** 2026-11-09 · **Rama:** `feat/m2-terminal` (desde `docs/integrations-direction`)
**Fuentes:** PRD § "Cambio de dirección (2026-11-09)" (criterios 1–5), `PRODUCT.md`, `DESIGN.md` (Obsidian), `docs/spikes/m2-pty-findings.md`.

## Objetivo

El panel expandido del notch muestra una fila de iconos de integraciones. La primera, **Terminal**, convierte el panel en una terminal real de PowerShell de ~640×360 sin salir de lo que se está haciendo. La sesión sigue viva al cerrar el panel y solo se ejecuta lo que el usuario escribe en ella.

## Decisiones

| Tema | Decisión | Motivo |
|---|---|---|
| PTY | `node-pty@1.1.0` oficial, ConPTY del sistema | Binarios N-API precompilados; 0,4–1,6 s hasta el primer comando (spike) |
| Dónde vive xterm | **En el mismo renderer del notch** (opción B del usuario) | Menos piezas y morph trivial. **Sustituye** la mitigación del PRD "la terminal vive en su propia ventana/webContents aislada": el aislamiento se garantiza en main (ver Seguridad) |
| Shell | `pwsh.exe` si existe; si no, `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | PowerShell moderno con respaldo siempre presente |
| Cuándo nace la sesión | Al pulsar el icono por primera vez (y de nuevo tras `exit`) | Cero coste en reposo si no se usa |
| Criterio "< 1 s" | Desde el click hasta terminal visible **y** primera salida del shell | Con `pwsh`, el prompt tarda ~1,6 s en aparecer (aceptado por el usuario) |
| Fin de sesión | Nunca `pty.kill()`; muere con la app o con `exit` | `kill()` hace `fork` y el fusible `runAsNode` está apagado (spike) |
| Salir de la terminal | Atajo global, click fuera, o botón «volver» de la cabecera | Esc pertenece a PowerShell |
| Reabrir el panel | Siempre en la fila de integraciones (vista `home`) | Decisión del usuario; la sesión está a un click |
| CSP | `style-src 'self' 'unsafe-inline'` en producción; `script-src 'self'` intacto | xterm.js crea `<style>` en tiempo de ejecución |

## Arquitectura

### Estado y geometría (`src/shared/notch/`)

- `NotchState` gana `view: 'home' | 'terminal'`. `NotchMode` gana `'terminal'` = expandido con `view === 'terminal'`.
- Eventos nuevos: `open-integration { id: 'terminal' }` → `expanded: true, view: 'terminal'`; `back` → `view: 'home'`.
- `dismiss`, `toggle` (al cerrar) y `user-visibility hidden` ponen `view: 'home'`, de modo que reabrir muestra la fila.
- `CAPSULE_SIZES.terminal = { width: 640, height: 360 }`. El morph usa la estrategia de M0 ya implementada: crecer ventana → animar; animar → encoger ventana.
- Controlador: los modos con panel (`expanded`, `terminal`) llaman a `focus()` al entrar y a `blur()` al salir a un modo sin panel; `expanded ↔ terminal` no toca el foco. Windows devuelve el foco a la app anterior tras `blur` (M0).

### Sesión PTY en main (`src/main/terminal/`)

- `shell-resolver.ts`: `resolveShell({ exists, env })` → ruta absoluta. Busca `pwsh.exe` en `PATH` y en `%LOCALAPPDATA%\Microsoft\WindowsApps`; si no, Windows PowerShell 5.1. Puro y testeable (`exists` inyectado).
- `terminal-session.ts`: `createTerminalSession({ spawn, shell, cwd, env, emit, logger, flushMs = 8, scrollbackBytes = 256 KiB })`.
  - `open()` → `{ state: 'running' | 'exited', exitCode?, snapshot, shell }`; crea el PTY si no hay uno vivo (`xterm-256color`, cwd = carpeta de usuario, 100×20).
  - `write(data)`, `resize(cols, rows)`: no-op si no hay sesión viva.
  - La salida se acumula en un búfer circular (historial para `snapshot`) y se emite en lotes cada ~8 ms (`terminal:data`).
  - `onExit` → estado `exited` + evento `terminal:exit { exitCode }`; el siguiente `open()` crea otra sesión.
  - No expone el PTY ni llama a `kill()`.
- `node-pty` se inyecta como `spawn`, así los tests usan un PTY falso.

### IPC (`src/shared/ipc/`, `src/main/ipc/`)

Canales nuevos en el contrato zod:

| Canal | Entrada | Salida |
|---|---|---|
| `terminal:open` | — | `{ state, exitCode?, snapshot: string, shell: string }` |
| `terminal:input` | `{ data: string (1..65536) }` | `null` |
| `terminal:resize` | `{ cols: int 2..500, rows: int 1..200 }` | `null` |
| `notch:open-integration` | `{ id: 'terminal' }` | `null` |
| `notch:back` | — | `null` |

Eventos main → renderer: `terminal:data` (`string`), `terminal:exit` (`{ exitCode: int }`), enviados solo al webContents del notch.

### Renderer (`src/renderer/notch/`)

- `src/shared/integrations/registry.ts`: lista `{ id, labelKey }` (hoy solo `terminal`); el renderer asocia el icono Lucide (`SquareTerminal`). El panel pinta una fila de tiles con el registro, encima de Control Center / Ocultar.
- `TerminalView.tsx`: cabecera de 32 px (botón volver, nombre del shell en Geist Mono, aviso «sesión terminada · Enter para reiniciar» tras `exit`) y xterm 6 + `@xterm/addon-fit`, Geist Mono 13 px, tema Obsidian (fondo `#0E0E10`, texto Tiza, cursor/selección Azul Hielo, ANSI ajustado a los tokens de estado).
  - Al montar: suscribe `terminal:data`/`terminal:exit`, llama a `terminal:open`, escribe el `snapshot`, ajusta tamaño (`terminal:resize`) y enfoca xterm.
  - `onData` de xterm → `terminal:input`.
- El listener global de Esc ignora la tecla cuando el modo es `terminal`.
- i18n ES/EN para todas las etiquetas nuevas.

## Seguridad

Regla aprobada: **solo se ejecuta lo que el usuario escribe en la terminal.**

1. Solo main crea la sesión; el renderer no elige ejecutable, argumentos, cwd ni entorno.
2. Solo el handler de `terminal:input` llega a `session.write`. El módulo de sesión no se pasa a ningún otro handler.
3. Los canales `terminal:*` exigen, además del guard de URL existente, que el remitente sea **el webContents del notch** (`FORBIDDEN` para el Control Center u otro).
4. Entradas validadas con zod y acotadas (64 KiB por escritura, límites de cols/rows).
5. Eventos de salida solo al webContents del notch.
6. CSP: se relaja solo `style-src` (`'unsafe-inline'`) por xterm; `script-src 'self'`, `default-src 'none'` y el resto siguen igual. No hay contenido remoto.
7. Logs: nunca se registra lo que se escribe ni la salida del shell.

## Arreglo incluido

`src/main/windows/secure-window.ts`: `will-frame-navigate` solo se bloquea si `!event.isMainFrame` (si no, se bloquea la recarga de Vite en dev). Se trae solo ese cambio de c49d5b7 (más el `rmSync` con reintentos del E2E), con su test.

## Empaquetado

- `dependencies`: `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`.
- `electron-builder.yml`: `asarUnpack: ['**/node_modules/node-pty/**']` y `npmRebuild: false` (los binarios N-API precompilados sirven tal cual; recompilar exigiría Visual Studio).
- La salida solo se envía al renderer mientras la terminal está visible (`isViewing`); con el panel cerrado se acumula en el historial y se repinta al volver.

## Pruebas

- **Unitarias (TDD):** estado/geometría; `shell-resolver`; `terminal-session` con PTY falso (lotes, búfer circular, `exit` y reapertura, nunca `kill`, límites); contrato y guard de los canales `terminal:*` incluida una tabla que demuestra que ningún canal salvo `terminal:input` provoca escrituras (criterio 4); controlador (foco/blur del modo `terminal`); `secure-window`; CSP.
- **E2E (`_electron`):** el icono abre una terminal real < 1 s; `Get-ChildItem` y `git status`; `ping -t` + Ctrl+C; cerrar y reabrir conserva el historial; Esc no cierra; el Control Center recibe `FORBIDDEN` en `terminal:input`; capturas en `test-results/`.
- **Después:** revisión de seguridad con subagente; RAM y CPU en reposo con la sesión abierta.

## Fuera de alcance

Varias pestañas o sesiones, elegir shell en el Control Center, menú contextual de copiar/pegar (pegar con Ctrl+V funciona por el evento `paste` del navegador; copiar con Ctrl+Shift+C se añade solo si sale barato), temas claros, otras integraciones.
