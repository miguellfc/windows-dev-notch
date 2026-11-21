# 0.3.0 · Entrega 3 — Nueva cápsula compacta: plan de implementación

> **Para agentes:** sub-skill obligatoria: superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`).

**Objetivo:** la cápsula compacta pasa a tener tres zonas fijas: hora y fecha | integraciones | sistema. El sistema muestra siempre CPU, RAM, almacenamiento, conexión y batería.

**Arquitectura:**
- **Muestra ligera.** Gana un campo `storage`: la peor unidad fija (la de menos espacio libre) con su porcentaje usado. Sale de la misma lectura barata de discos que ya existe cada 60 s y se guarda en caché entre lecturas.
- **Conexión.** Sale de `navigator.onLine` en el renderer, sin pasar por Rust.
- **Anchos.** `compactWidthFor` deja de ser una tabla de combinaciones: pasa a sumar anchos medidos por zona y por bloque. Se miden una vez en el WebView2 real con una e2e temporal y quedan como constantes en TS y en su espejo de Rust. `WINDOW_WIDTH` se recalcula con el peor caso.

**Tecnología:** React 19, Tailwind 4, zod, Rust (Tauri 2), Vitest, `cargo test`, WebdriverIO con `tauri-driver`.

**Spec:** `docs/superpowers/specs/2026-11-17-v030-redesign-design.md`, sección «Cápsula compacta (cambia)».

**Fuera de esta entrega:** el panel principal (entrega 4) y las vistas simplificadas (entrega 5).

## Restricciones globales

- **Rama:** `feat/v030-capsule` desde `dev`, en la carpeta principal del repo. **Sin worktrees.** PR hacia `dev`.
- **Commits:** locales autorizados; **nunca push** sin pedirlo. Cada commit lleva el trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Límites:**
  - No editar `eslint.config.mjs` ni los hooks.
  - No cerrar procesos que no lancen las pruebas.
  - Las e2e necesitan cerrada la Developer Notch instalada; hay que pedírselo al usuario.
- **Distribución de la cápsula compacta**, de izquierda a derecha:
  1. **Hora y fecha**, siempre.
  2. **Integraciones**, solo las que cumplen `capsuleShows(key)`, en el orden `claude, gmail, github, gitlab, redmine`. Cada bloque lleva su icono de 12 px en el color de la integración y la cifra en Geist Mono, en Tiza.
  3. **Sistema**, en este orden: CPU %, RAM %, almacenamiento («C: 62%», % usado), conexión (icono sin cifra) y batería % (solo si hay batería). Todo en Geist Mono y Grafito Cristal; la cifra pasa a rojo cuando hay aviso.
- **Divisores:** entre zonas hay un divisor vertical de 1 px por 14 px, en `--color-line-strong`.
  - Si no hay bloques de integraciones, desaparecen la zona central y su divisor.
  - Si no hay muestra de sistema (`unavailable` tres veces seguidas), desaparecen la zona de sistema y su divisor.
- **Los puntos de Claude ya no sustituyen a la fecha.** La fecha queda siempre a la izquierda y los puntos son un bloque más del centro. Si ninguna sesión tiene punto, el bloque no aparece.
- **Aviso de disco:** no añade un bloque aparte. El bloque de almacenamiento es siempre el mismo; en aviso, su cifra pasa a rojo y su etiqueta accesible lo dice.
- **Latches:** se mantienen los de hoy (`CAPSULE_MISSES`, desaparición inmediata sin sesión, etc.).
- **Ancho:** nunca se anima `width`; el cambio de ancho sigue usando el fundido cruzado actual. Cada valor reserva su peor ancho («100 %», «99+», «23,75h», «W: 100 %»).
- **ES/EN:** todo texto nuevo va en los dos idiomas, y los anchos se miden con la cadena más larga.

## Decisiones tomadas en este plan

- **La hora de la cápsula (peek y compacta) sigue en Geist Mono, no en Jersey 10.** En la entrega 1, el usuario decidió reservar Jersey para las cifras grandes porque a tamaño pequeño se ve borrosa, y aquí la hora va a 13 px. El peek no cambia (168×36).
- **Conexión:** un solo icono que distingue con red (`Globe`) y sin red (`GlobeOff`, en `text-fail`), sin cifra. Se obtiene de `navigator.onLine` y de los eventos `online`/`offline`.
  - No distingue wifi de ethernet: haría falta `GetAdaptersAddresses` y nuevas features de `windows-sys`.
  - La spec permite este repliegue.
- **Almacenamiento:** es la misma unidad que vigila el aviso de disco, la de menos espacio libre.
  - Muestra el % usado, que es 100 − % libre.
  - Entre lecturas (cada 60 s) se conserva el último valor.
  - Si no hay lectura, el bloque muestra «—» sin cambiar de ancho.

## Foco de revisión

1. **Peor caso de contenido, en ES y en EN:** 4 puntos de Claude más «+9», «99+» en correo y en las dos revisiones, «23,75h», CPU y RAM al «100 %», disco «W: 100 %» y batería al «100 %». Nada se recorta ni salta de línea. Lo cubre la e2e de la Task 5.
2. **Arranque:** antes de la primera lectura de discos, o si esta falla, el almacenamiento muestra «—» con el mismo ancho. Lo cubren el latch (Task 2) y Rust (Task 1).
3. **Perder o recuperar la conexión:** solo cambia el icono; el ancho no se mueve. Lo cubre la prueba unitaria de la Task 2.
4. **Entrar en aviso de disco:** la cifra pasa a rojo, sin bloque nuevo y sin cambio de ancho. Lo cubren el latch (Task 2) y `compactWidthFor` (Task 3).
5. **Ocultar todas las integraciones de la cápsula:** desaparecen la zona central y su divisor, y el ancho baja exactamente en lo que medían. Lo cubre `compactWidthFor` (Task 3).

---

### Task 1: Almacenamiento en la muestra ligera (Rust + contrato)

**Archivos:**
- Modificar: `src/shared/system/schema.ts` (`lightSampleSchema` con `storage`)
- Modificar: `src-tauri/src/contract/system.rs`. Añade `LightSample.storage: Option<StorageSample>`, con `StorageSample { letter, used_percent }` en camelCase y la letra con el mismo tipo que `DiskAlert`.
- Modificar: `src-tauri/src/system/monitor.rs` (`tick_inner` / `light_disks`: guarda la última lectura en caché y la incluye en cada muestra ligera y completa), `system/metrics.rs` y `system/fake.rs`
- Modificar: `tests/parity/contract-cases.json` (los casos de `system:metrics` que tengan muestra ligera)
- Tests: `src-tauri/src/system/monitor/tests.rs` y `tests/unit/shared/system-schema.test.ts`

**Interfaces (produce):**
- TS: `lightSampleSchema.storage`, definido como `z.strictObject({ letter: z.string().regex(/^[A-Z]$/), usedPercent: percentSchema }).nullable()`. `fullSampleSchema` lo hereda.
- Rust: `StorageSample { letter, used_percent }`. La unidad es la de menor `free_percent` en `Metrics::disks()`, y `used_percent = 100 − free_percent`.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - Rust:
    - `light_sample_carries_worst_drive_storage`: con C: al 40 % libre y D: al 10 % libre, `storage` es D con 90.
    - `storage_is_kept_between_disk_reads`: el segundo tick ligero dentro de los 60 s repite el valor.
    - `storage_is_null_without_a_reading`: sin unidades fijas, o con `disks()` en `None` la primera vez, da `None`.
  - TS: el esquema acepta `storage: null` y `{letter:'C', usedPercent:62}`, y rechaza `letter:'c'`.
- [ ] **Paso 2:** `cargo test --manifest-path src-tauri/Cargo.toml system::` y `npx vitest run tests/unit/shared/system-schema.test.ts` → FAIL.
- [ ] **Paso 3: implementar.** Sin llamadas nuevas al sistema: se reutiliza la lectura de `light_disks` (cada `DISK_CHECK_MS`, 60 s).
- [ ] **Paso 4:** `npm run test:rust` (con fmt y clippy), `npx vitest run`, `npm run typecheck` y `npm run lint` → PASS.
- [ ] **Paso 5: commit** `feat(system): almacenamiento de la peor unidad en la muestra ligera`.

### Task 2: Latch de almacenamiento, conexión y textos

**Archivos:**
- Modificar: `src/renderer/notch/system/capsule-latch.ts`. Añade `CapsuleView.storage: { letter: string; usedPercent: number | null; alert: boolean } | null`. `CapsuleView.disk` desaparece y el aviso pasa a `storage.alert`.
- Crear: `src/renderer/shared/use-online.ts`
- Modificar: `src/shared/i18n/messages.ts`
- Tests: `tests/unit/renderer/system-capsule-latch.test.ts` y `tests/unit/renderer/online.test.ts` (nuevo)

**Interfaces (produce):**
- `nextCapsule` rellena `storage` así:
  - letra y `usedPercent` salen de `metrics.storage`;
  - `alert` es true mientras `metrics.alerts.disk` siga enganchado (el latch de 3 fallos de hoy) y apunte a esa letra;
  - si no hay `metrics.storage`, queda `{ letter: alerts.disk?.letter ?? 'C', usedPercent: null, alert }`;
  - `storage` solo es `null` cuando la vista entera es `null`.
- `useOnline(): boolean`, sobre `navigator.onLine` y los eventos `online`/`offline`. La lógica pura va aparte: `onlineFrom(nav: { onLine: boolean } | undefined): boolean`, que devuelve `true` si no hay navigator.
- i18n:

| Clave | ES | EN |
|---|---|---|
| `system.capsule.storage` | «Disco {letter}: {value} usado» | «Disk {letter}: {value} used» |
| `system.capsule.storageLow` | «Disco {letter}: {value} usado, poco espacio libre» | «Disk {letter}: {value} used, low on space» |
| `system.capsule.online` | «Con conexión» | «Online» |
| `system.capsule.offline` | «Sin conexión» | «Offline» |

  `system.capsule.diskLow` se borra si queda sin uso.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - Latch:
    - `storage {C,62}` sin aviso da `storage {C,62,false}`;
    - con `alerts.disk {C,5}` da `alert: true`;
    - el aviso se mantiene durante 3 fallos;
    - sin `storage` da `usedPercent: null`;
    - con `unavailable` tres veces, la vista es `null`.
  - Conexión: `onlineFrom({onLine:false}) === false` y `onlineFrom(undefined) === true`.
- [ ] **Paso 2:** `npx vitest run tests/unit/renderer/system-capsule-latch.test.ts tests/unit/renderer/online.test.ts` → FAIL.
- [ ] **Paso 3: implementar.** Actualizar también los consumidores de `CapsuleView.disk` para que typecheck pase. El bloque de disco se retira en la Task 3.
- [ ] **Paso 4:** `npx vitest run`, `npm run typecheck` y `npm run lint` → PASS.
- [ ] **Paso 5: commit** `feat(capsule): almacenamiento siempre visible, conexión y textos`.

### Task 3: Nueva distribución, medición y geometría (TS)

**Archivos:**
- Modificar:
  - `src/renderer/notch/NotchApp.tsx` (`CapsuleContent`: tres zonas, divisores, fecha siempre presente, puntos de Claude como bloque del centro);
  - `src/renderer/notch/system/CapsuleMetrics.tsx` (bloques de almacenamiento y conexión en la zona de sistema, sin bloque de disco);
  - `src/renderer/notch/claude/StatusDots.tsx` (como bloque, sin `fallback`, reservando el ancho de 4 puntos más «+9»).
- Modificar: `src/shared/notch/geometry.ts`. `COMPACT_WIDTHS`, `REVIEW_BLOCK_WIDTH`, `REDMINE_BLOCK_WIDTH` y `FIRST_BLOCK_EXTRA` se sustituyen por `COMPACT_ZONE` y `CAPSULE_BLOCK`; hay una `compactWidthFor` nueva y se recalcula `WINDOW_WIDTH`.
- Crear y borrar antes del commit: la e2e temporal de medición `tests/e2e-tauri/zz-measure.spec.ts`.
- Tests: `tests/unit/shared/notch-geometry.test.ts` y `tests/unit/shared/parity.test.ts` (regenera `tests/parity/geometry.json` con `PARITY_UPDATE`).

**Interfaces:**
- **Consume:** de la Task 2, `CapsuleView.storage` y `useOnline`; de la entrega 2, `capsuleShows` y `useIntegration`.
- **Produce:**
  - `COMPACT_ZONE = { padding, divider, left, system, battery }`, en px medidos:
    - `padding`: el relleno horizontal total;
    - `divider`: 1 px más los dos huecos que lo rodean;
    - `left`: hora y fecha, el peor caso entre ES y EN;
    - `system`: CPU, RAM, almacenamiento y conexión, sin batería;
    - `battery`: lo que añade la batería, con su hueco.
  - `CAPSULE_BLOCK = { claude, mail, review, redmine }`, en px medidos, cada uno con su hueco.
  - `compactWidthFor(content: { system: { battery: boolean } | null; blocks: { claude: boolean; mail: boolean; reviews: 0 | 1 | 2; redmine: boolean } }): number`. Devuelve `ceil` de esta suma:
    - `padding + left`;
    - si hay algún bloque: `divider` + la suma de los bloques;
    - si hay sistema: `divider + system`, más `battery` si la tiene.
  - El peek sigue en 168×36 si coincide con `ceil(padding + left)`. Si la medición da otro valor, el peek pasa a `ceil(padding + left)`, y hay que anotarlo.
  - `WINDOW_WIDTH` = `ceil((max(peor compacta, anchos de los paneles) + 112) / 2) * 2`. La peor compacta lleva todos los bloques, 2 revisiones, sistema y batería.

- [ ] **Paso 1: implementar la nueva distribución** en `CapsuleContent`, con los anchos actuales como provisionales.
  - Las tres zonas llevan `shrink-0` y cada valor conserva su `reserve`.
  - Mantener los `data-testid` existentes: `capsule-metrics`, `metric-cpu`, `metric-ram`, `metric-battery`, `metric-mail`, `metric-review-*`, `metric-redmine` y `claude-dots`.
  - Añadir `metric-storage`, `metric-connection`, `capsule-zone-left`, `capsule-zone-blocks` y `capsule-zone-system`.
- [ ] **Paso 2: medir.**
  - Con la notch instalada cerrada (pedírselo al usuario), crear `zz-measure.spec.ts`.
  - El spec siembra el peor caso: al menos 4 sesiones de Claude con distintos estados vía el bridge, correo «99+», revisiones 2×«99+», horas «23,75» y un aviso de disco.
  - Mide con `getBoundingClientRect` cada zona, bloque, divisor y padding, en ES y en EN.
  - Ejecutar con `npm run test:e2e -- --spec tests/e2e-tauri/zz-measure.spec.ts`, anotar la tabla de medidas en el informe y borrar el spec.
- [ ] **Paso 3: escribir las pruebas que fallan** en `notch-geometry.test.ts`, con los valores medidos:
  - sin bloques y sin sistema da `ceil(padding+left)`;
  - solo sistema sin batería da `ceil(padding+left+divider+system)`;
  - la batería suma `battery`;
  - cada bloque suma su ancho, y una zona central vacía no suma `divider`;
  - el peor caso cumple `+112 ≤ WINDOW_WIDTH`;
  - el aviso de disco no cambia el ancho, porque no es una entrada de la función;
  - `WINDOW_WIDTH` es igual a la fórmula.
- [ ] **Paso 4: implementar la geometría.** Sustituir los anchos provisionales y regenerar `tests/parity/geometry.json` con `PARITY_UPDATE=1 npx vitest run tests/unit/shared/parity.test.ts`. La paridad en Rust falla hasta la Task 4, y es lo esperado.
- [ ] **Paso 5:** `npx vitest run`, `npm run typecheck`, `npm run lint` y `npm run build:tauri-renderer` → PASS.
- [ ] **Paso 6: commit** `feat(capsule): tres zonas con anchos medidos`.

### Task 4: Espejo de la geometría en Rust

**Archivos:**
- Modificar: `src-tauri/src/notch/geometry.rs`. `WIDTH_*`, `REVIEW_BLOCK_WIDTH`, `FIRST_BLOCK_EXTRA` y `REDMINE_BLOCK_WIDTH` se sustituyen por los equivalentes de `COMPACT_ZONE` y `CAPSULE_BLOCK`; `compact_width_for` mantiene la misma firma lógica; `WINDOW_WIDTH` cambia junto con su prueba de fórmula.
- Modificar: `src-tauri/src/notch/mod.rs` (`geometry_matches_ts` con el nuevo formato de `compactWidths`) y `src-tauri/src/notch/cursor.rs:258` (la prueba que fija el peek y `WINDOW_WIDTH`)
- Tests: los de esos módulos y `src-tauri/tests/parity.rs`

**Interfaces:**
- **Consume:** el `tests/parity/geometry.json` de la Task 3. Su `compactWidths` enumera `{system: null|sin batería|con batería} × claude × mail × reviews(0..2) × redmine`.
- **Produce:** `pub fn compact_width_for(system: Option<SystemZone>, blocks: CapsuleBlocks) -> f64`, que coincide con TS en todas las combinaciones de `geometry.json`.

- [ ] **Paso 1:** `cargo test --manifest-path src-tauri/Cargo.toml notch::` → FAIL (paridad con el `geometry.json` nuevo).
- [ ] **Paso 2: implementar.** La ventana nativa (`window.rs`) y `default_capsule_rect` usan el `WINDOW_WIDTH` nuevo.
- [ ] **Paso 3:** `npm run test:rust` (con fmt y clippy) → PASS.
- [ ] **Paso 4: commit** `feat(notch): espejo Rust de la nueva geometría de la cápsula`.

### Task 5: E2E, DESIGN.md y verificación

**Archivos:**
- Modificar: `tests/e2e-tauri/app.spec.ts`, o crear `tests/e2e-tauri/capsule.spec.ts` y añadirlo a `specs` en `tests/e2e-tauri/wdio.conf.mts`.
- Modificar: los specs que dependían del bloque de disco o de que los puntos sustituyeran a la fecha (`system-alerts.spec.ts`, `claude.spec.ts`). Solo donde haga falta, y con el motivo en el commit.
- Modificar: `DESIGN.md`. La sección de la cápsula compacta pasa a describir las tres zonas, los anchos medidos, el almacenamiento, la conexión y la hora en Geist Mono. Se retiran los textos sobre `COMPACT_WIDTHS`, el bloque de disco y los puntos que sustituyen a la fecha.

- [ ] **Paso 1: escribir la e2e**, en ES y repetida en EN:
  - `compact capsule worst case fits`: con el peor caso sembrado como en la Task 3, ninguna zona ni bloque se desborda (`scrollWidth <= clientWidth` y rects dentro de la cápsula), y el ancho de la cápsula es igual a `compactWidthFor(...)` ±1 px.
  - `storage and connection always show`: aparecen `metric-storage` («C: n %», con la etiqueta «Disco C: … usado») y `metric-connection` («Con conexión»).
  - `hiding every capsule integration removes the middle zone`: al apagar «Cápsula» en las 5 desde Control Center, desaparece `capsule-zone-blocks`.
- [ ] **Paso 2: e2e completa.** Con la notch instalada cerrada, `npm run test:e2e` → PASS. Repetir por separado las pruebas inestables conocidas: `system.spec` («closes a busy process») y Gmail.
- [ ] **Paso 3: capturas** de la cápsula compacta en ES con cuatro contenidos: el peor caso, un contenido normal, sin integraciones y sin conexión (si se puede simular). Dejarlas en la carpeta de notas compartida para el usuario.
- [ ] **Paso 4: verificación final.** `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build:tauri-renderer` y `npm run test:rust`.
- [ ] **Paso 5: commit** `docs(design): cápsula compacta en tres zonas`.
