# Tauri, parte 7: cierre — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dejar la versión Tauri lista para publicarse como 0.2.0: sin Electron en el repositorio, con un instalador que sustituye a la 0.1.0 sin borrar sus datos, inicio con Windows comprobado, la medición final frente a los objetivos y la documentación y avisos de licencias al día.

**Architecture:** no hay código nuevo de producto salvo el gancho NSIS del instalador, el arreglo del inicio con Windows si hace falta, el del foco del panel si se reproduce y dos scripts (`scripts/measure-idle.ps1` y `scripts/third-party-notices.mjs`). El resto es retirar Electron (`src/main`, `src/preload`, sus pruebas y dependencias), mover los servidores falsos de las pruebas a `tests/e2e-tauri/fixtures` y reescribir la documentación.

**Tech Stack:** el de las partes 1–6; NSIS de Tauri 2 con `installerHooks`.

**Spec:** `docs/superpowers/specs/2026-11-14-tauri-migration-design.md` (parte 7 del orden de partes, objetivos y decisión de actualizar desde la 0.1.0).
**Mapa:** `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_6c5a11ba-2674-4805-8266-3018f9f3d913\tauri-part7-map.md`.

## Decisiones del usuario

- La diferencia de zona horaria entre Rust (Windows) y la interfaz (ICU) se publica como diferencia conocida en el CHANGELOG y se arregla después de la 0.2.0.
- Si la 0.1.0 está instalada para todos los usuarios, el instalador avisa, pide permisos de administrador y la desinstala; si el usuario cancela, la instalación se detiene.
- Las licencias de los crates se generan con un script propio sobre `cargo metadata`, sin instalar herramientas.
- La medición final la ejecuta el usuario con un script del repositorio sobre la app instalada con sus integraciones reales.

## Decisiones mías (revisables)

- `npm run dev` y `npm run build` pasan a ser los de Tauri (`tauri dev`, `tauri build`); se conservan `tauri:dev` y `tauri:build` como alias. `test:e2e:tauri` pasa a `test:e2e` y se conserva el alias.
- La versión se escribe `0.2.0` en `package.json`, y `tauri.conf.json` la lee de `../package.json`; `Cargo.toml` también `0.2.0`.
- Instalador en español e inglés con selector de idioma, `publisher` «Developer Notch», WebView2 con `downloadBootstrapper` (no va dentro). Se borra el valor `Run` huérfano de la 0.1.0.
- `docs/tauri-e2e.md` pasa a `docs/e2e.md`. Los comentarios de Rust que citan archivos de `src/main` se reescriben sin ruta.
- `src/renderer` no cambia (el CSS de la barra de título de Electron y la CSP se quedan; no molestan).

## Global Constraints

- Siguen vigentes las de las partes 1–6: nada de commits sin aprobación, gates de calidad, `src/renderer` sin cambios, no se edita `eslint.config.mjs` ni los hooks del repositorio.
- No se ejecuta ningún instalador ni desinstalador en el equipo del usuario sin pedírselo; las pruebas del instalador las hace el usuario con la lista de la tarea 2.
- La paridad zod↔serde (`tests/unit/shared/parity.test.ts` y `cargo test --test parity`) sigue funcionando sin `src/main`.
- Objetivos: instalador NSIS de 10 MB o menos; memoria privada en reposo de 230 MB o menos medida como dice el spec (si no se alcanza, se informa con el desglose y no bloquea).

## Review Focus

1. **Actualizar con la 0.1.0 instalada por usuario o para todos:** se desinstala sin borrar `%APPDATA%\Developer Notch`, no queda el valor de inicio de la 0.1.0 y la 0.2.0 arranca con Windows una sola vez. Prueba manual del usuario en la tarea 2 con `dist/Developer Notch Setup 0.1.0.exe`.
2. **Ruta del ejecutable con espacios en el inicio con Windows:** el valor `Run` lleva comillas y arranca de verdad. Prueba en la tarea 3.
3. **Nada roto al retirar Electron:** lint, typecheck, `npm test`, `npm run test:rust`, paridad y la suite e2e completa dos veces. Prueba en las tareas 1 y 4.
4. **Panel que pierde el foco con el Control Center abierto (pendiente 2):** se reproduce con entrada real o se descarta con evidencia; si se reproduce, se arregla. Tarea 4.
5. **El ejecutable publicado no lleva nada de pruebas:** ni `__e2e:` ni los interruptores `NOTCH_*`. Tarea 4.

---

### Task 1: Retirar Electron

**Files:**
- Delete: `src/main/`, `src/preload/`, `tests/unit/main/`, `tests/unit/helpers/`, `tests/e2e/*.spec.ts`, `tests/e2e/{dom,pointer,settle}.ts`, `electron-builder.yml`, `electron.vite.config.mts`, `playwright.config.mts`
- Move: `tests/e2e/fixtures/` → `tests/e2e-tauri/fixtures/` (y arreglar las 3 importaciones)
- Modify: `package.json` (scripts, sin `main`, `npm uninstall electron electron-builder electron-vite @playwright/test html-to-text koffi @types/html-to-text`), `package-lock.json`, `tsconfig.node.json`, `vitest.config.mts`, la configuración de Vite de la interfaz si dependía de electron-vite (mapa §1 y §8)

**Interfaces:**
- Produces: scripts `dev`, `build`, `test`, `test:rust`, `test:e2e`, `lint`, `typecheck` y los alias `tauri:dev`, `tauri:build`, `test:e2e:tauri`.
- [ ] **Step 1:** Comprobar con búsqueda que nada de lo que se queda importa lo que se borra (mapa §1–2).
- [ ] **Step 2:** Borrar, mover y desinstalar.
- [ ] **Step 3:** Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:rust`, `npx vitest run tests/unit/shared/parity.test.ts`, `npm run build` (ahora Tauri). Expected: PASS.
- [ ] **Step 4: Commit** `chore: retirar Electron`

### Task 2: Instalador y actualización desde la 0.1.0

**Files:**
- Create: `src-tauri/windows/hooks.nsh`
- Modify: `src-tauri/tauri.conf.json` (versión desde `../package.json`, `publisher`, `copyright`, `shortDescription`, idiomas es/en con selector, `webviewInstallMode` explícito, `installerHooks`), `src-tauri/Cargo.toml` y `package.json` (`0.2.0`)

**Interfaces:**
- Produces (mapa §3): `NSIS_HOOK_PREINSTALL` que busca `Software\Microsoft\Windows\CurrentVersion\Uninstall\38a9d2fb-eef1-505d-af16-fc0f6b0e6c06` en HKCU y luego en HKLM; si existe, aviso bilingüe Aceptar/Cancelar (silencioso acepta); para HKLM pide elevación; ejecuta el desinstalador con `ExecWait` y `_?=<dir>` en modo silencioso, sin `--delete-app-data`; borra el desinstalador y la carpeta; borra `Run` y `StartupApproved\Run` de `dev.developernotch.app`. Cancelar detiene la instalación. `NSIS_HOOK_POSTUNINSTALL` borra `Run\Developer Notch` si la plantilla de Tauri no lo hace.
- [ ] **Step 1:** Escribir el gancho y la configuración.
- [ ] **Step 2:** Run `npm run build`. Expected: instalador `≤ 10 MB` con la versión 0.2.0; anotar el tamaño.
- [ ] **Step 3:** Pendiente de prueba manual por el usuario (lista en el informe): instalar la 0.1.0 por usuario → instalar la 0.2.0 (aviso, desinstalación, datos de la 0.1.0 intactos, un solo valor de inicio); repetir con la 0.1.0 para todos los usuarios (pide administrador); cancelar el aviso (no instala); instalar sin la 0.1.0 (sin aviso); desinstalar la 0.2.0 (no queda valor de inicio).
- [ ] **Step 4: Commit** `build(tauri): instalador 0.2.0 que sustituye a la 0.1.0`

### Task 3: Inicio con Windows

**Files:**
- Modify: el módulo de inicio con Windows de la parte 1 (mapa §4)

**Interfaces:**
- Produces: el valor `HKCU\...\Run\Developer Notch` con la ruta entre comillas, activado y desactivado desde el Control Center como en la 0.1.0.
- [ ] **Step 1: Write the failing test**: `autostart_value_quotes_a_path_with_spaces` (sobre la función que construye el valor; sin tocar el registro real).
- [ ] **Step 2:** Run `npm run test:rust`. Expected: FAIL si hoy va sin comillas.
- [ ] **Step 3:** Arreglar.
- [ ] **Step 4:** Run. Expected: PASS. Pendiente de prueba manual por el usuario con la app instalada: activar, reiniciar sesión, comprobar que arranca; desactivar.
- [ ] **Step 5: Commit** `fix(tauri): inicio con Windows con la ruta entre comillas`

### Task 4: Comprobaciones de publicación y pendientes de foco

**Files:**
- Modify: según lo que se encuentre (`src-tauri/src/notch/window.rs` si se confirma el pendiente 2), `tests/e2e-tauri/*` solo si un fallo es de la prueba

**Interfaces:**
- Produces: una prueba de que el ejecutable publicado no contiene `__e2e:` ni lee interruptores `NOTCH_*` (búsqueda en el binario de `npm run build`); el pendiente 2 reproducido con entrada real por el usuario (pasos en el informe) o descartado con evidencia; si se confirma, arreglo con su prueba; la suite completa dos veces seguidas con el recuento exacto.
- [ ] **Step 1:** Comprobar el binario publicado.
- [ ] **Step 2:** Investigar el pendiente 2 (secuencia `set_focusable(true)` + `set_focus()`), con el registro de la parte 6 que distingue el cierre por foco.
- [ ] **Step 3:** Run `npm run test:e2e` dos veces seguidas. Expected: 61 PASS (o 60 + la de RAM omitida); cualquier fallo de pruebas antiguas se describe con exactitud.
- [ ] **Step 4: Commit** solo si hubo cambios: `fix(tauri): ...`

### Task 5: Medición final

**Files:**
- Create: `scripts/measure-idle.ps1`
- Modify: `spikes/tauri-capsule/RESULTS.md` (sección «Final 0.2.0»)

**Interfaces:**
- Produces: un script que mide, sobre la app instalada y en marcha, el árbol de procesos completo (memoria privada, conjunto de trabajo, CPU en ventanas de 15 y 60 s), dos veces, con el desglose por proceso y sin leer ni enviar datos del usuario.
- [ ] **Step 1:** Escribir el script y probarlo sobre una compilación con carpeta de datos temporal.
- [ ] **Step 2:** Pendiente del usuario: instalar la 0.2.0, configurar sus integraciones, dejar el notch en peek con el Control Center cerrado, ejecutar el script dos veces y pasar la salida.
- [ ] **Step 3:** Escribir la sección final frente a los objetivos (≤ 10 MB, ≤ 230 MB), con el desglose si no se alcanza.
- [ ] **Step 4: Commit** `docs: medición final de la 0.2.0`

### Task 6: Documentación y avisos de licencias

**Files:**
- Create: `scripts/third-party-notices.mjs`
- Modify: `README.md`, `CHANGELOG.md`, `docs/redmine-setup.md` y las demás guías que citen Electron o `safeStorage`, `docs/tauri-e2e.md` → `docs/e2e.md`, `THIRD_PARTY_NOTICES.md`, los comentarios de Rust que citan archivos borrados

**Interfaces:**
- Produces: `THIRD_PARTY_NOTICES.md` generado por el script a partir de `cargo metadata` (crates de ejecución en Windows, con su licencia y, para MPL y las que lo exijan, el texto), las dependencias npm que van en la interfaz (incluida la OFL de las fuentes Geist) y los iconos ya listados; `CHANGELOG.md` con `[0.2.0]` (qué cambia para el usuario, que hay que volver a configurar las integraciones y reinstalar los hooks de Claude, que los datos de la 0.1.0 se conservan pero no se migran, y las diferencias conocidas, empezando por la de zona horaria); `README.md` reescrito para Tauri.
- [ ] **Step 1:** Escribir el script y generar el archivo.
- [ ] **Step 2:** Reescribir la documentación.
- [ ] **Step 3:** Run `npm run lint` y comprobar que no queda ninguna mención a `npm run dev` de Electron, `electron-builder` ni `safeStorage` (búsqueda).
- [ ] **Step 4: Commit** `docs: documentación y licencias de la 0.2.0`

---

## Fuera de esta parte

- La diferencia de zona horaria (después de la 0.2.0, decisión del usuario).
- Los pendientes menores de las partes 3, 5 y 6 que el mapa marca como «después».
- Publicar: etiquetar, subir el instalador y anunciarlo lo hace el usuario.
