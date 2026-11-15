# Baldosas que abren apps: Claude Desktop y Windows Terminal — Diseño (corto)

**Fecha:** 2026-11-13 · **Rama:** `feat/claude-chat` (desde `dev`)

> **Cambio (2026-11-13):** sustituye a la primera versión de este documento (claude.ai incrustado en el panel con un `WebContentsView`). El usuario la descartó: el botón solo abre Claude Desktop. En la misma ronda pidió lo mismo para la baldosa Terminal, que deja de abrir la terminal integrada.

## Objetivo

Dos baldosas del panel dejan de abrir algo dentro del notch y abren la app real de Windows:

- **Claude** (nueva, la séptima) → una **conversación nueva en Claude Desktop** (sección Chat, no Code).
- **Terminal** (ya existe) → una **ventana nueva de Windows Terminal con PowerShell 7** en `C:\Users\migue`.

La terminal integrada del notch (xterm + node-pty) **se elimina**.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Claude | Abre **Claude Desktop** en un **chat nuevo** cada vez |
| Botón de Claude | **Séptima baldosa "Claude"**, al final de la fila |
| Terminal | **Windows Terminal + PowerShell 7 (`pwsh`)**, ventana nueva, en `C:\Users\migue` |
| Terminal integrada | **Eliminarla**: vista, proceso, dependencias, tamaño de panel y pruebas |

## Enfoques

| Enfoque | Por qué sí / no |
|---|---|
| **Claude: enlace `claude://claude.ai/new`** con `shell.openExternal` (elegido) | Claude Desktop (MSIX `Claude_pzs8sxrjxfjjc`) registra el protocolo `claude`. Windows abre la app o la trae al frente y ella va al chat nuevo |
| Claude: lanzar `claude.exe` y traerla al frente | Abre la app, pero no garantiza el chat nuevo |
| Claude: traerla al frente y simular Ctrl+N | Simular teclado es frágil y está vetado en el proyecto |
| **Terminal: lanzar `wt.exe -w new -d <carpeta> pwsh.exe -NoLogo`** como proceso independiente (elegido) | Abre siempre una ventana nueva en la carpeta indicada, con el shell indicado y sin heredar el notch |
| Terminal: abrir `pwsh` suelto y dejar que Windows elija el terminal | Depende del ajuste "terminal predeterminado" de Windows: no garantiza Windows Terminal |

## Comportamiento

**Comunes a las dos baldosas:**
- Al pulsar, el panel se cierra (vuelve a la cápsula) y se abre la app.
- No son vistas del panel: no hay tamaños nuevos ni cambios en el reductor, salvo cerrar el panel.
- Los clics repetidos en menos de 1 s se ignoran. *(Decisión mía.)*

**Claude:**
- Abre `claude://claude.ai/new`.
- Sin Claude Desktop instalado, `openExternal` falla y se abre `https://claude.ai/new` en el navegador. *(Decisión mía.)*

**Terminal:**
- **Carpeta**: la de usuario (`app.getPath('home')`, que en este equipo es `C:\Users\migue`). *(Decisión mía: es la carpeta que pidió el usuario sin escribir la ruta en el código.)*
- **Comando**: `wt.exe -w new -d "<carpeta>" pwsh.exe -NoLogo`. Se lanza con `spawn` sin shell, `detached` y `stdio: 'ignore'`, y se suelta con `unref()`. Así la ventana sobrevive al notch y no hereda sus variables de desarrollo (`NOTCH_*`).
- **Si falta Windows Terminal**: `pwsh` en su propia consola, en la misma carpeta. **Si falta `pwsh`**: `powershell.exe` (5.1). *(Decisión mía.)*

**Si algo falla del todo:** la cápsula muestra un aviso breve "No se pudo abrir <app>". El constructor decide si lo hace con un aviso existente o con un texto en la cápsula.

## Arquitectura

- **Registro** (`src/shared/integrations/registry.ts`):
  - `terminal` y la nueva `claude` pasan a ser **acciones** (abren una app), no vistas.
  - El resto (Recordatorios, Sistema, Notas, Gmail, Revisiones) siguen siendo vistas.
  - Orden de la fila: Terminal, Recordatorios, Sistema, Notas, Gmail, Revisiones, Claude.
- **IPC** notch → main, con validación zod y guard `fromNotch`:
  - `apps:open { app: 'claude' | 'terminal' }`.
  - Main abre la app y despacha `intent: 'dismiss'`.
- **Main** — `src/main/apps/app-launcher.ts`:
  - Contiene las órdenes y los respaldos.
  - Recibe inyectados `openExternal`, `spawn` y "existe el ejecutable", para poder probarlo sin abrir nada.
- **Eliminar la terminal integrada:**
  - **Código**:
    - `src/main/terminal/*`;
    - `src/shared/terminal/*`;
    - `TerminalView`, `TerminalBoundary`, `terminal-loader`, `terminal-theme`;
    - la carga anticipada en `IntegrationRow`;
    - la excepción de Esc de la terminal en `NotchApp`.
  - **Estado e IPC**: el modo/vista `terminal` de `state.ts`, `contract.ts` y `channels.ts`, y sus registros IPC en `index.ts` / `register.ts`.
  - **Geometría**: el tamaño `terminal` (640×360), que era el panel más ancho. Se revisa el ancho de la ventana y el orden de redimensionado con el nuevo panel más ancho.
  - **Dependencias y empaquetado**: `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, más su configuración de compilación nativa o `asarUnpack` si la hay.
  - **Pruebas**: `terminal.spec.ts`, `terminal-session.test.ts`, `shell-resolver.test.ts`, `chunk-input.test.ts`, y los casos de terminal en `app.spec`, `claude.spec`, `reminders.spec`, `notch-state`, `notch-geometry`, `notch-controller`, `register-ipc`, `ipc-contract` y `system-monitor`.
  - **Textos**: i18n que ya no se use.
  - **Documentación**: `DESIGN.md` y PRD.
  - Hay que revisar que `src/main/system/win32-system.ts` no dependa de nada eliminado.
- **Fila de 7 baldosas**: hoy mide 414 de 416 px con 6. Se mide de nuevo y se ajusta (relleno horizontal o etiquetas). `app.spec` sigue comprobando en ES y EN que ninguna etiqueta se corta.
- **Log**: solo `apps:open` con la app y el resultado (`desktop` | `browser` | `wt` | `pwsh` | `powershell` | `failed`). Nunca rutas ni variables de entorno.
- **Pruebas sin abrir nada**: un interruptor de desarrollo (ignorado empaquetado) sustituye el lanzador por un registro de llamadas. Así las pruebas nunca abren Claude Desktop, el navegador ni una terminal.

## Riesgo

El enlace `claude://claude.ai/new` es como se abren conversaciones de claude.ai en la app, pero Anthropic no lo documenta. **Primera tarea:** el usuario prueba a mano el enlace (con la app cerrada y con la app abierta) y la orden de `wt` y confirma que abren lo esperado. Si el enlace no abre un chat nuevo, se vuelve a hablar antes de seguir.

## Pruebas

- **Unitarias**:
  - contrato IPC;
  - lanzador de Claude: URL de la app, respaldo al navegador, cierre del panel;
  - lanzador de Terminal: argumentos de `wt` con la carpeta de usuario, respaldos `pwsh` → `powershell`, `detached`/`unref`, sin variables `NOTCH_*` en el entorno;
  - doble clic ignorado;
  - estado y geometría sin `terminal`.
- **E2E**:
  - las baldosas Claude y Terminal registran la llamada esperada y cierran el panel;
  - la fila de 7 no corta etiquetas (ES/EN);
  - no queda ninguna vista de terminal;
  - captura de la fila.
- **Manual (usuario)**: con Claude Desktop y Windows Terminal reales.

## Fuera de alcance

- Chat dentro del notch y terminal dentro del notch.
- Abrir Code en Claude Desktop o una conversación concreta.
- Elegir otra carpeta, otro perfil de Windows Terminal o pestañas en vez de ventana.
- Atajos globales nuevos.
