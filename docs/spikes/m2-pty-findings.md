# M2 · Spike de `node-pty` en Electron 45 — Hallazgos

**Fecha:** 2026-11-09 · **Código:** desechable, fuera del repo (scratchpad de la sesión); no se reutiliza.
**Entorno:** Windows 11 Pro 26300, Electron 45.2.3 (Node 24.22.2, ABI 150), sin Visual Studio ni herramientas de compilación C++.

## Veredicto

`node-pty@1.1.0` **funciona dentro del proceso main de Electron 45 sin compilar nada**: el paquete oficial trae binarios N-API precompilados para `win32-x64` (`prebuilds/win32-x64/*.node`) y, al ser N-API, no dependen del ABI de Electron. No hace falta la variante `@lydell/node-pty` ni `electron-rebuild`.

## Medidas (proceso main, ConPTY)

Tiempo desde `spawn` hasta que se ejecuta el primer comando (un marcador que solo aparece cuando PowerShell lo ha ejecutado de verdad):

| Shell | ConPTY del sistema | `useConptyDll: true` (conpty.dll + OpenConsole.exe del paquete) |
|---|---|---|
| Windows PowerShell 5.1 (`powershell.exe`) | **0,42 s** | 3,4 s |
| PowerShell 7 (`pwsh.exe`, alias de WindowsApps) | 1,57 s | 4,6 s |

- `require('node-pty')`: ~5 ms. `spawn`: 50–70 ms. Primera salida: < 100 ms.
- Funciona: colores y resaltado de PSReadLine, `Get-ChildItem`, `ping -t` + Ctrl+C (`\x03`) vuelve al prompt, `resize`.
- Detalle: tras Ctrl+C la consola descarta lo que se escriba en el mismo instante (igual que en Windows Terminal).
- RSS del proceso main con la sesión abierta: ~80 MB en el spike.

## Medidas de M2 (build de producción, 2026-11-09)

Árbol de procesos de la app (Electron + conhost + pwsh), muestreo de 60 s en reposo, panel cerrado, 16 hilos:

| | Memoria privada | Working set | CPU |
|---|---|---|---|
| Sin sesión de terminal | 183 MB | 354 MB | 0,01 % |
| Con la sesión de `pwsh` abierta | 286 MB | 539 MB | 0,02 % |

- `pwsh.exe` (con el perfil del usuario, oh-my-posh) aporta ~53 MB privados; renderer y main suben ~13 MB cada uno (xterm y node-pty).
- Con la sesión abierta se superaba el objetivo original "RAM total < 200 MB"; sin sesión se cumple. La CPU en reposo se mantiene ≈ 0 %. **Decisión del usuario (2026-11-09):** el objetivo pasa a "< 200 MB sin integraciones abiertas"; el coste de la terminal abierta se acepta (ver PRODUCT.md).
- Primera salida del shell tras el click en el icono (E2E): 141–213 ms.

## Hallazgos que cambian la implementación

1. **No llamar nunca a `pty.kill()`.** Con la ConPTY del sistema, `kill()` hace `child_process.fork()` de `conpty_console_list_agent` para listar los procesos de la consola. En la app empaquetada el fusible `runAsNode` está desactivado, así que ese `fork` arrancaría **otra instancia de la app**, que chocaría con el bloqueo de instancia única y dispararía `second-instance` (que expande el notch). En desarrollo, además, el agente falla con `AttachConsole failed` (inofensivo: hay un timeout de 5 s).
   - Comprobado: si la app sale **sin** `kill()`, ConPTY cierra PowerShell y sus hijos (un `ping -t` en marcha desaparece en < 1 s). La sesión muere con la app o cuando el usuario escribe `exit`.
2. **ConPTY del sistema, no `useConptyDll`.** La DLL empaquetada evitaría el `fork` pero añade ~3 s al arranque.
3. **Empaquetado:** los binarios (`.node`, `.dll`, `.exe`) deben ir fuera del asar (`asarUnpack`).
4. **El alias de `pwsh.exe` en WindowsApps** es un *reparse point*: `fs.existsSync` dice que no existe y la app caía a 5.1. Se comprueba con `lstat` (`pathExists`).
5. **pwsh frente a 5.1:** `pwsh` tarda ~1,6 s en estar listo. Decisión del usuario: usar `pwsh` si existe (si no, 5.1) y crear la sesión al pulsar el icono; el criterio "< 1 s" se mide hasta que la terminal es visible y llega la primera salida del shell.
