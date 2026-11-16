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

## Parte 2: sistema, notas, recordatorios y apps (2026-11-15)

La parte 1 más el monitor del sistema (métricas de la cápsula, alertas, vista Sistema con la lista de procesos), las notas, los recordatorios (avisos, notificaciones de Windows, eventos de energía) y las baldosas de Claude y Terminal. Claude, GitHub, GitLab, Redmine y Gmail siguen respondiendo `UNAVAILABLE`. Compilado con `npm run tauri:build` (perfil `release`, NSIS) y medido igual que la parte 1: el ejecutable de `release` con la carpeta de datos real, 15 s después de arrancar, en reposo en peek (ventana de la cápsula visible), sin abrir el Control Center y sin integraciones configuradas. Además de la ventana de 15 s de `measure.ps1`, se midió la CPU durante 60 s.

| | Memoria privada | Conjunto de trabajo | CPU en reposo (15 s / 60 s) | Instalador | En disco |
|---|---|---|---|---|---|
| Developer Notch 0.2.0-dev (Tauri, parte 2) | 180–187 MB | 404–406 MB | 0,10 % / 0,22 % | 2,37 MB | 8,2 MB exe + WebView2 del sistema |

Desglose de la memoria privada por proceso: principal (Rust) 7, navegador WebView2 36, GPU 83, renderer 33, utilidades 11 y 7, crashpad 3.

Lectura:

- Siguen siendo 7 procesos. La memoria privada sube unos 25–30 MB respecto a la parte 1 (155 MB). Casi todo es WebView2; la mayor partida es el proceso de GPU (83 MB; no hay desglose por proceso de la parte 1 para compararlo). El proceso de Rust con los cuatro módulos nuevos se queda en 7 MB.
- El instalador pasa de 2,19 a 2,37 MB y el ejecutable de 7,5 a 8,2 MB, por los módulos nuevos y las dependencias de notificaciones (`tauri-winrt-notification`), identificadores (`uuid`) y normalización de texto (`icu_normalizer`).
- CPU: ahora el monitor del sistema sigue muestreando en peek (ritmo ligero, cada 3 s), y aun así la medida sale más baja que en la parte 1 (0,9 %): 0,10 % de un núcleo en la ventana de 15 s y 0,22 % en la de 60 s. Con tan poco consumo, la medida depende mucho de qué hagan los procesos de WebView2 durante la ventana; la diferencia con la parte 1 entra en ese ruido, no se debe a ningún cambio que la reduzca.
- La prueba de extremo a extremo de coste en reposo mide sobre la compilación de depuración con WebDriver conectado y da entre 0,54 y 1,07 % de un núcleo. Con 16 procesadores lógicos eso es entre 0,034 y 0,067 % de la máquina, la unidad de `percentCPUUsage` de Electron (comprobado: un núcleo ocupado durante 2 s marca 6,26 %), muy por debajo del umbral de 0,5 % de la prueba de Electron.
- El ejecutable de `release` sigue sin ningún canal `__e2e:`.

## Parte 3: Claude Code (2026-11-15)

La parte 2 más la integración con Claude Code: el puente HTTP local de los hooks (solo `127.0.0.1`), el instalador de hooks del `settings.json` de Claude, los permisos y las preguntas retenidos hasta que se responden, las sesiones, las notificaciones y traer Claude al frente. GitHub, GitLab, Redmine y Gmail siguen respondiendo `UNAVAILABLE`. Compilado con `npm run tauri:build` (perfil `release`, NSIS) y medido igual que la parte 2: el ejecutable de `release` con la carpeta de datos real, 15 s después de arrancar, en reposo en peek, sin abrir el Control Center. El puente arranca en su puerto aleatorio, pero los hooks no están instalados (instalarlos necesita la confirmación del usuario), así que no llega ningún evento: es el coste del puente escuchando sin trabajo.

| | Memoria privada | Conjunto de trabajo | CPU en reposo (15 s / 60 s) | Instalador | En disco |
|---|---|---|---|---|---|
| Developer Notch 0.2.0-dev (Tauri, parte 3) | 175–189 MB | 388–398 MB | 0,40 % / 0,28 % | 2,60 MB | 8,95 MB exe + WebView2 del sistema |

Desglose de la memoria privada por proceso: principal (Rust) 7, navegador WebView2 35, GPU 84, renderer 32, red 11, almacenamiento 7, crashpad 3.

Lectura:

- Siguen siendo 7 procesos y la memoria queda donde estaba en la parte 2 (180–187 MB). El proceso de Rust con el puente, los intermediarios y el registro de sesiones sigue en 7 MB.
- El instalador pasa de 2,37 a 2,60 MB y el ejecutable de 8,2 a 8,95 MB, por el servidor HTTP (`hyper`, `hyper-util`), el cifrado del token con DPAPI, `base64`, `getrandom` y el módulo de Claude.
- CPU: la primera ventana de 15 s, justo a los 15 s del arranque, marcó 1,50 % de un núcleo; repetida un minuto después, 0,40 %, y la de 60 s, 0,28 %. La primera aún recoge el final del arranque de WebView2. Con el puente sin tráfico no hay trabajo propio de Claude salvo la comprobación de los hooks cada 60 s, así que la diferencia con la parte 2 (0,10 % / 0,22 %) entra en el ruido de los procesos de WebView2.
- Las pruebas de extremo a extremo pasan de 28 a 44 (`claude.spec.ts` y `claude-questions.spec.ts`, 8 cada una) y completan la prueba de `apps.spec.ts` que quedó a medias en la parte 2 (la línea de fallo con sesiones de Claude en el panel). De la petición de permiso al aviso en la cápsula pasan entre 19 y 30 ms en las dos ejecuciones completas (la prueba exige menos de 1 s).
- El ejecutable de `release` sigue sin ningún canal `__e2e:`.

## Parte 4: revisiones de código de GitHub y GitLab (2026-11-16)

La parte 3 más las revisiones de código: los clientes HTTP de GitHub (GraphQL) y GitLab (REST) con TLS del almacén de Windows y sin redirecciones, el sondeo cada 120 s con esperas progresivas, el aviso de primera revisión, las contribuciones (solo con la vista abierta), los tokens cifrados con DPAPI y los 8 canales `code-review:*`. Redmine y Gmail siguen respondiendo `UNAVAILABLE`. Compilado con `npm run tauri:build` (perfil `release`, NSIS).

La medición cambia en un punto respecto a la parte 3: no se usa la carpeta de datos real. El ejecutable de `release` normal no respeta `NOTCH_USER_DATA_DIR`, y con la parte 4 la carpeta real puede guardar tokens de verdad, con los que la app consultaría GitHub y GitLab. Por eso se midió una compilación de `release` con la feature `e2e` (`tauri build --no-bundle --features e2e`, en otra carpeta de destino), con una carpeta de datos temporal y vacía, el `settings.json` de Claude temporal, el puerto del puente efímero y las dos plataformas apuntando a un puerto cerrado de `127.0.0.1`. Así, las revisiones están sin configurar, igual que en la medición de la parte 3. Por lo demás, el método es el mismo: árbol de procesos completo, 15 s después de arrancar, en reposo en peek y sin abrir el Control Center, con una ventana de CPU de 15 s y otra de 60 s. Se midió dos veces; los procesos se cerraron al acabar.

Dos salvedades al comparar con la parte 3:

- El perfil está vacío, con los ajustes por defecto; la parte 3 se midió con los ajustes reales del usuario.
- El binario medido lleva la feature `e2e`, así que no es exactamente el ejecutable que se distribuye (incluye los canales `__e2e:*` y respeta los interruptores de prueba). El tamaño del instalador y del ejecutable sí son los de `npm run tauri:build`.

| | Memoria privada | Conjunto de trabajo | CPU en reposo (15 s / 60 s) | Instalador | En disco |
|---|---|---|---|---|---|
| Developer Notch 0.2.0-dev (Tauri, parte 4) | 174–179 MB | 374–389 MB | 0,31–0,42 % / 0,31–0,62 % | 2,89 MB | 9,99 MB exe + WebView2 del sistema |

Desglose de la memoria privada por proceso: principal (Rust) 7, navegador WebView2 33–34, GPU 79–83, renderer 33, red 12, almacenamiento 7, crashpad 3.

Lectura:

- Siguen siendo 7 procesos y la memoria queda donde estaba en las partes 2 y 3 (175–189 MB). El proceso de Rust con el cliente HTTP, el almacén de tokens y el sondeo sigue en 7 MB.
- El instalador pasa de 2,60 a 2,89 MB y el ejecutable de 8,95 a 9,99 MB, por el cliente HTTP (`reqwest` con TLS del almacén de certificados de Windows), `url` y el módulo de revisiones de código.
- CPU: entre 0,31 y 0,62 % de un núcleo, en el mismo ruido de los procesos de WebView2 que en las partes 2 y 3. Sin tokens no hay sondeo; con tokens, el trabajo propio es una consulta por plataforma cada 120 s.
- Las pruebas de extremo a extremo pasan de 44 a 49 (`code-review.spec.ts`, 5) y tardan unos 3 min y 40 s. Corren contra el servidor falso de Electron en `127.0.0.1`, sin tokens reales y sin abrir el navegador.
- El ejecutable de `release` sigue sin ningún canal `__e2e:` (comprobado buscando el texto en el binario).

