# Prueba Tauri 2 frente a Electron (2026-11-14)

Prueba desechable. La misma página de la cápsula (`ui/index.html`, peek de 168×36 que se ensancha a 358 al pasar el puntero) en una Electron 45.2.3 mínima (`electron/`) y en Tauri 2 con WebView2 157 (`src-tauri/`). Las dos vigilan el cursor cada 33 ms y activan o desactivan el paso de clics. Mediciones en reposo con el árbol de procesos completo (`measure.ps1` en el scratchpad de la sesión). Windows 11 y un monitor a escala 1.

| | Memoria privada | Conjunto de trabajo | CPU en reposo | Instalador | En disco |
|---|---|---|---|---|---|
| Developer Notch 0.1.0 (Electron, app completa) | 301 MB | 494 MB | 1,2 % | 117 MB | 344 MB |
| Electron mínima, misma cápsula | 130 MB | 307 MB | 0,4 % | — | 357 MB (dist de desarrollo) |
| Tauri mínima, misma cápsula | 138 MB | 351 MB | 0,6 % | 1,07 MB | 3,2 MB exe + WebView2 del sistema |

Desglose de la memoria privada por proceso:

- 0.1.0: principal (Node) 106, GPU 134, renderer 83, red 13, audio 10.
- Tauri mínima: principal (Rust) 5, navegador WebView2 36, GPU 55, renderer 23, red 12, almacenamiento 7, crashpad 4.

Lectura:

- Con la misma página, WebView2 gasta lo mismo que Electron. Los dos son Chromium. El ahorro de memoria de Tauri viene solo de sustituir el proceso principal de Node (106 MB en la 0.1.0) por Rust (unos 5–20 MB con las integraciones). Estimación para la app completa: entre 200 y 230 MB, un 25–35 % menos.
- El instalador sí cambia de orden de magnitud: pasa de 117 MB a 1 MB en la cápsula mínima. Con React, las fuentes y el resto de la interfaz quedaría en unos 3–8 MB.
- El proceso de GPU de la 0.1.0 (134 MB) es la mayor partida y no depende del motor. Se puede reducir también en Electron revisando efectos como el desenfoque y las capas animadas.

Comportamiento de la ventana en Tauri:

- Al mostrarse no roba el foco (`ShowWindow(SW_SHOWNOACTIVATE)`, comprobado con `GetForegroundWindow`).
- Queda siempre encima, transparente y con paso de clics: estilos `WS_EX_TOPMOST`, `WS_EX_LAYERED` y `WS_EX_TRANSPARENT`.
- Se coloca arriba al centro del área de trabajo del monitor bajo el cursor.
- Trampa encontrada: mostrar la ventana con un `ShowWindow` directo la deja visible, pero tao guarda su propia marca de visibilidad. Con la marca en «oculta», el siguiente cambio de estilo (activar o quitar el paso de clics al pasar el puntero) vuelve a ocultar la ventana. Hay que mostrarla siempre con `window.show()`.
- `"focus": false` solo vale mientras tao crea la ventana. Después, `show()` la activa. Para que la cápsula no robe nunca el foco hay que usar `"focusable": false` (`WS_EX_NOACTIVATE`). El panel, que necesita teclado, tendría que cambiar a `set_focusable(true)` al abrirse.
- Revisado a mano por el usuario: el aspecto, el ensanche al pasar el puntero y los clics a través de la zona transparente funcionan.

## Parte 1: esqueleto de la app en Tauri (2026-11-15)

Ya no es la cápsula mínima: es `src-tauri/` con la interfaz completa de React (cápsula, panel y Control Center), los ajustes, el registro de uso, la bandeja y el atajo global. Las integraciones de las partes 2 a 6 aún responden `UNAVAILABLE`. Compilado con `npm run tauri:build` (perfil `release`, NSIS); NSIS acepta la versión `0.2.0-dev` tal cual. Medido igual que arriba, 15 s después de arrancar, en reposo en peek, sin abrir el Control Center.

| | Memoria privada | Conjunto de trabajo | CPU en reposo | Instalador | En disco |
|---|---|---|---|---|---|
| Developer Notch 0.2.0-dev (Tauri, parte 1) | 155 MB | 354 MB | 0,9 % | 2,19 MB | 7,5 MB exe + WebView2 del sistema |

Lectura:

- 7 procesos: el principal de Rust y 6 de WebView2. Son 17 MB de memoria privada más que la cápsula mínima, por React, las fuentes y la interfaz completa; todavía sin las integraciones, que sumarán su parte.
- El instalador queda en 2,19 MB, por debajo de la estimación de 3–8 MB, frente a los 117 MB de la 0.1.0.
- El ejecutable de `release` no contiene ningún canal `__e2e:`: solo existen con la feature `e2e`, que usan las pruebas de extremo a extremo (`docs/tauri-e2e.md`).
