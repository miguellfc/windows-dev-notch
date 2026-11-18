# 0.3.0 · Entrega 2 — Integraciones configurables: plan de implementación

> **Para agentes:** sub-skill obligatoria: superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans. Los pasos usan casillas (`- [ ]`).

**Objetivo:** cada integración se puede activar o desactivar, mostrar u ocultar en la cápsula y colorear desde una nueva página «Integraciones» de Control Center. El color tiñe sus vistas, alertas e icono, y una integración desactivada deja de consultar y de avisar.

**Arquitectura:**
- **Ajustes:** pasan a v8 con un bloque `integrations`, en TS y en su espejo de Rust. La migración v7→v8 se hace en Rust al cargar el archivo.
- **Paleta:** una paleta cerrada de 21 colores vive en `src/shared/integrations/colors.ts` y en tokens CSS `--color-int-<id>`. Cada vista o alerta pone `--int` en su raíz, y lo que ya lee `var(--int)` (rejillas, anillos, sparklines) toma el color sin más cambios.
- **Backend:** escucha `SettingsStore::on_change`. Pausa y reanuda Gmail, revisiones y Redmine. Claude deja de interceptar y los recordatorios dejan de avisar.

**Tecnología:** zod, React 19, Tailwind CSS 4, Rust (serde, Tauri 2), Vitest, `cargo test`, WebdriverIO con `tauri-driver`.

**Spec:** `docs/superpowers/specs/2026-11-17-v030-redesign-design.md`. Secciones: «Color por integración», «Control Center → Página nueva: Integraciones», «Alertas», «Datos y ajustes» y las decisiones del usuario sobre desactivar Claude.

**Fuera de esta entrega:**
- Entrega 3: la nueva distribución de la cápsula compacta (zonas, almacenamiento y conexión).
- Entrega 4: el panel con accesos rápidos y tarjetas.
- Entrega 5: las vistas simplificadas.

Aquí, «Cápsula» solo oculta o muestra los bloques que la cápsula ya tiene hoy.

## Restricciones globales

- **Rama y commits:** rama `feat/v030-integrations` desde `dev`, con PR hacia `dev`. Los commits locales están autorizados, pero **nunca push** sin pedirlo. Cada commit lleva el trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Límites:**
  - No editar `eslint.config.mjs` ni los hooks.
  - No cerrar procesos que no lancen las pruebas.
  - Las e2e necesitan cerrada la Developer Notch instalada; hay que pedírselo al usuario.
- **Claves de integración**, en este orden: `claude, github, gitlab, gmail, redmine, reminders, notes, system`. Solo `claude, github, gitlab, gmail, redmine` admiten «Cápsula».
- **Paleta de 21 colores** (id ASCII, nombre ES/EN y hex). Dos valores están **ajustados en este plan** (ver «Decisiones»):

| id | ES | EN | hex |
|---|---|---|---|
| pistachio | Pistacho | Pistachio | `#D9F99D` |
| lime | Lima | Lime | `#A3E635` |
| green | Verde | Green | `#4ADE80` |
| emerald | Esmeralda | Emerald | `#10B981` |
| teal | Turquesa | Teal | `#2DD4BF` |
| cyan | Cian | Cyan | `#22D3EE` |
| sky | Celeste | Sky | `#38BDF8` |
| blue | Azul | Blue | `#7DD3FC` |
| cobalt | Cobalto | Cobalt | `#60A5FA` |
| indigo | Índigo | Indigo | `#818CF8` |
| violet | Violeta | Violet | `#A78BFA` |
| lavender | Lavanda | Lavender | `#C4B5FD` |
| plum | Ciruela | Plum | `#C084FC` |
| fuchsia | Fucsia | Fuchsia | `#E879F9` |
| pink | Rosa | Pink | `#F472B6` |
| salmon | Salmón | Salmon | `#FDA4AF` |
| peach | Melocotón | Peach | `#FDBA74` |
| orange | Naranja | Orange | `#FB923C` |
| amber | Ámbar | Amber | `#FBBF24` |
| clay | Arcilla | Clay | `#CC785C` |
| sand | Arena | Sand | `#D6C7A1` |

- **Colores por defecto:**

| Integración | Color |
|---|---|
| claude | clay |
| github | green |
| gitlab | orange |
| gmail | salmon |
| redmine | pink |
| reminders | blue |
| notes | violet |
| system | teal |

- **Dónde va el color:**
  - el icono de la integración en su casilla, en su bloque de cápsula, en la cabecera de su vista y en sus alertas;
  - sus visualizaciones vía `--int`: rejillas de contribuciones y de horas, anillos y sparklines;
  - el punto de no leído de Gmail y la chincheta de Notas;
  - la confirmación de éxito de su vista.
- **Dónde no va nunca:** fondos, texto de cuerpo, botones principales (siguen en Tiza) y anillo de foco. Además, el coral y el rojo ganan siempre al color de la integración en un mismo elemento, y el toast de Windows no se colorea.
- **Desactivar una integración:**
  - Desaparecen su casilla, su bloque de cápsula y sus alertas, y deja de consultar.
  - Su configuración (tokens, sesión) no se borra.
  - Sistema solo quita la casilla y la vista; las métricas de la cápsula y los avisos siguen.
  - Claude: el hook sigue instalado, pero el bridge no retiene permisos ni preguntas, así que Claude Code pregunta en su propia interfaz. Ninguna sesión puede quedarse esperando a la notch.
- **Copy ES/EN** en `src/shared/i18n/messages.ts`.
- **Accesibilidad:** foco Tiza visible. El selector de color es un Radio Group, con un único punto de Tab y flechas que mueven y seleccionan.

## Decisiones tomadas en este plan

- **Ajuste de hex para separarse del coral y del rojo.** El criterio es una distancia OKLab ≥ 0,07 frente al coral `#FF8A7A` y frente al rojo `#F87171`.
  - Salmón: `#F28B82` → `#FDA4AF`. Antes estaba a 0,024 del coral.
  - Arcilla: `#D97757` → `#CC785C`. Antes estaba a 0,067 del rojo.
  - Naranja (0,072) y Rosa (0,097 del rojo) se quedan como están.
  - Todos los colores dan ≥ 5:1 sobre la tarjeta.
- **Recordatorios desactivados:** no hay alerta, toast, chime ni badge. Los recordatorios que venzan mientras tanto aparecen como vencidos al reactivarlos.
- **Integración desactivada con su vista abierta:** la vista se cierra y vuelve a `home`. Si llega después una respuesta que estaba en vuelo, se descarta.
- **Página nueva `integrations`** en Control Center, después de «Atajo». No se abre desde el notch.

## Foco de revisión

1. **Usuario que actualiza con `settings.json` v7:** debe cargar como v8, con todo activado y los demás ajustes intactos, sin cuarentena. Lo cubre la Task 2 (Rust).
2. **Desactivar Claude con un permiso pendiente:** Claude Code recibe «sin decisión» en el acto y no queda ninguna conexión retenida. Lo cubre la Task 6.
3. **Desactivar Gmail a mitad de una consulta:** después no llega alerta ni datos. Al reactivar, consulta enseguida, sin esperar un tick entero. Lo cubre la Task 5.
4. **Desactivar una integración con su vista abierta:** el panel vuelve a `home`. Lo cubren la Task 4 (prueba unitaria de la función de visibilidad) y la e2e de la Task 7.
5. **Selector de color con teclado, en ES y EN:** las flechas mueven y seleccionan, Esc cierra, hay un solo punto de Tab y cada muestra lleva `aria-label` con su nombre. Lo cubren la Task 3 (prueba unitaria del roving) y la e2e de la Task 7.

---

### Task 1: Paleta, ajustes v8 (TS) y textos

**Archivos:**
- Crear: `src/shared/integrations/colors.ts`
- Modificar: `src/shared/settings/schema.ts` (`SETTINGS_VERSION` 8, bloque `integrations`, defaults, patch)
- Modificar: `src/shared/i18n/messages.ts` (claves nuevas en `es` y `en`)
- Tests:
  - `tests/unit/shared/integration-colors.test.ts` (nuevo)
  - `tests/unit/shared/settings-schema.test.ts`
  - `tests/unit/shared/i18n.test.ts` (sin cambios, debe seguir en verde)

**Interfaces (produce):**
- **`colors.ts`:**
  - `integrationKeys = ['claude','github','gitlab','gmail','redmine','reminders','notes','system'] as const`, con su tipo `IntegrationKey`.
  - `capsuleIntegrationKeys = ['claude','github','gitlab','gmail','redmine'] as const`, con su tipo `CapsuleIntegrationKey`.
  - `integrationColorIds`: los 21 ids en el orden de la tabla, con su tipo `IntegrationColor`.
  - `INTEGRATION_COLOR_HEX: Readonly<Record<IntegrationColor, string>>`.
  - `DEFAULT_INTEGRATION_COLORS: Readonly<Record<IntegrationKey, IntegrationColor>>`.
- **`schema.ts`:**
  - `integrationSettingsSchema = z.strictObject({ enabled: z.boolean(), capsule: z.boolean(), color: z.enum(integrationColorIds) })`, con su tipo `IntegrationSettings`.
  - `integrationsSettingsSchema`: `strictObject` de las 8 claves, con un `refine` que exige `capsule === false` en `reminders`, `notes` y `system`. Su tipo es `IntegrationsSettings`.
  - `Settings.integrations`.
  - `cloneDefaultIntegrations(): IntegrationsSettings`: todas con `enabled: true`; `capsule: true` en las 5 de cápsula y `false` en el resto; los colores por defecto.
  - Patch: `integrations?: Partial<Record<IntegrationKey, Partial<IntegrationSettings>>>`. Se aplica con merge por clave y por campo.
- **Textos en `messages.ts`:**

| Clave | ES | EN |
|---|---|---|
| `cc.nav.integrations` | Integraciones | Integrations |
| `cc.integrations.title` | Integraciones | Integrations |
| `cc.integrations.intro` | Activa cada integración, elige si aparece en la cápsula y su color. | Turn each integration on, choose whether it shows in the capsule, and pick its color. |
| `cc.integrations.active` | Activa | On |
| `cc.integrations.capsule` | Cápsula | Capsule |
| `cc.integrations.color` | Color | Color |
| `cc.integrations.changeColor` | Cambiar color | Change color |
| `cc.integrations.always` | siempre | always |
| `cc.integrations.disabledNotice` | Desactivada · Activar en Integraciones | Off · Turn on in Integrations |

  - `color.<id>` para cada uno de los 21 colores, con los nombres de la tabla de la paleta.
  - Nombres de las 8 integraciones: reutilizar los `integration.*` existentes y añadir solo los que falten (`integration.claudeCode`: «Claude Code»).

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `integration-colors.test.ts`:
    - hay 21 ids, únicos, y cada uno tiene su hex;
    - `DEFAULT_INTEGRATION_COLORS` coincide con la tabla de Restricciones globales;
    - cada id tiene `color.<id>` en ES y EN.
  - `settings-schema.test.ts`:
    - `SETTINGS_VERSION` es 8;
    - `createDefaultSettings('es').integrations` es igual a `cloneDefaultIntegrations()`, con los valores exactos de arriba;
    - rechaza `capsule: true` en `notes`;
    - rechaza un color que no esté en la paleta;
    - el patch `{ integrations: { gmail: { color: 'blue' } } }` es válido.
- [ ] **Paso 2:** `npx vitest run tests/unit/shared/integration-colors.test.ts tests/unit/shared/settings-schema.test.ts` → FAIL.
- [ ] **Paso 3: implementar** lo de «Interfaces» y actualizar la prueba que fijaba la versión 7.
- [ ] **Paso 4:** `npx vitest run` → PASS. Con `npm run typecheck`, los errores que queden deben estar solo en los archivos de las Tasks 2 y 4 (parity, helpers de e2e); anotarlos en el informe.
- [ ] **Paso 5: commit** `feat(settings): integraciones v8 con paleta de 21 colores (TS)`.

### Task 2: Espejo Rust, migración v7→v8 y paridad

**Archivos:**
- Modificar: `src-tauri/src/contract/settings.rs`:
  - `SETTINGS_VERSION = 8`;
  - `IntegrationColor` con `#[serde(rename_all = "lowercase")]`;
  - `IntegrationSettings` e `IntegrationsSettings`;
  - `IntegrationSettingsPatch` e `IntegrationsPatch`, con `Option` en cada campo.
- Modificar:
  - `src-tauri/src/settings/defaults.rs`;
  - `settings/validate.rs`: `capsule` es false en `reminders`, `notes` y `system`, e `is_empty_patch` incluye `integrations`;
  - `settings/store.rs`: `apply_patch` hace merge por clave y por campo; la migración va en `load_from_disk`.
- Modificar:
  - `tests/parity/contract-cases.json`: los objetos de ajustes pasan a `version: 8` y llevan `integrations`;
  - `tests/e2e-tauri/helpers.ts`: las semillas son v8 válidas y se quita la nota «GAP: no migrations»;
  - `src-tauri/src/app_ipc.rs:193`: la versión de la prueba.
- Tests: inline en `settings/store.rs` y `settings/validate.rs`; `src-tauri/tests/parity.rs` y `tests/unit/shared/parity.test.ts`.

**Interfaces:**
- **Consume** el formato JSON de la Task 1, con los ids de color en minúsculas.
- **Produce:**
  - `fn migrate(raw: serde_json::Value) -> Option<serde_json::Value>` en `settings/store.rs`. Para `version == 7` inserta `integrations` por defecto y pone `version: 8`. Para cualquier versión anterior devuelve `None`, que lleva a la cuarentena actual.
  - `Settings.integrations: IntegrationsSettings`, que las Tasks 5 y 6 leen como `settings.integrations.gmail.enabled`.

- [ ] **Paso 1: escribir las pruebas Rust que fallan** (en `settings/store.rs`).
  - `v7_file_migrates_to_v8_keeping_other_fields`: escribir un v7 con `language: "en"` y un `shortcut` propio. Al cargar, la versión es 8, `integrations` tiene los valores por defecto, `language` sigue en `en` y el archivo en disco se reescribe como v8.
  - `older_than_v7_is_still_quarantined`: la prueba existente con la versión 6.
  - `patch_merges_one_integration_field`: un patch que pone `gmail.color = "blue"` deja `gmail.enabled` y `github` como estaban.
  - `validate_rejects_capsule_on_notes`.
- [ ] **Paso 2:** `cargo test --manifest-path src-tauri/Cargo.toml settings::` → FAIL.
- [ ] **Paso 3: implementar.** Después, `npx vitest run tests/unit/shared/parity.test.ts`. Si la prueba regenera los JSON de paridad, revisar el diff de `tests/parity/*.json`: solo debe cambiar la versión e `integrations`.
- [ ] **Paso 4:** `npm run test:rust` → PASS; `npx vitest run` → PASS; `npm run typecheck` y `npm run lint` → limpios.
- [ ] **Paso 5: commit** `feat(settings): espejo Rust de integraciones y migración v7→v8`.

### Task 3: Tokens de color, utilidades del renderer y selector de color

**Archivos:**
- Modificar: `src/renderer/styles/global.css` (`--color-int-<id>` para los 21 colores; `--color-int-default` pasa a `var(--color-int-green)`)
- Crear: `src/renderer/shared/integration-color.ts`, `src/renderer/ui/ColorSwatchPicker.tsx`
- Tests: `tests/unit/renderer/design-tokens.test.ts` (ampliar), `tests/unit/renderer/integration-color.test.ts` (nuevo)

**Interfaces (produce):**
- `integrationStyle(color: IntegrationColor): React.CSSProperties`, que devuelve `{ '--int': 'var(--color-int-<id>)' }`.
- `useIntegration(key: IntegrationKey): IntegrationSettings`, que lee de `useSettings`. Sin ajustes cargados, devuelve los valores por defecto.
- `ColorSwatchPicker({ value, onChange, label }: { value: IntegrationColor; onChange(c: IntegrationColor): void; label: string })`:
  - Un botón «Cambiar color» despliega una rejilla de 21 cuadrados de 28 px: 3 filas de 7 con huecos de 6 px.
  - Cada cuadrado es el color al 13 % con un punto sólido de 10 px. El actual lleva un borde de su color.
  - Teclado:
    - `role="radiogroup"` con un único punto de Tab;
    - las flechas mueven y seleccionan, con `src/renderer/ui/roving.ts`, y ↑ y ↓ saltan 7 posiciones;
    - Esc cierra y devuelve el foco al botón.
  - Cada cuadrado lleva `aria-label` con `color.<id>`.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `design-tokens.test.ts`:
    - cada `--color-int-<id>` existe y coincide con `INTEGRATION_COLOR_HEX`;
    - cada uno da ≥ 3:1 sobre la tarjeta compuesta;
    - cada uno está a una distancia OKLab ≥ 0,07 del coral (`--color-wait`) y del rojo (`--color-fail`).
  - `integration-color.test.ts`:
    - `integrationStyle('blue')` da `{'--int':'var(--color-int-blue)'}`.
    - Si la navegación del picker se extrae a una función pura `nextSwatch(index, key, columns=7, count=21)`, probar los bordes: → y ← dan la vuelta, y ↓ desde la última fila se queda donde está.
- [ ] **Paso 2:** `npx vitest run tests/unit/renderer/design-tokens.test.ts tests/unit/renderer/integration-color.test.ts` → FAIL.
- [ ] **Paso 3: implementar.**
- [ ] **Paso 4:** `npx vitest run`, `npm run typecheck` y `npm run lint` → PASS.
- [ ] **Paso 5: commit** `feat(ui): tokens de la paleta, --int por integración y selector de color`.

### Task 4: Control Center «Integraciones» y efectos en el notch

**Archivos:**
- Crear:
  - `src/renderer/control-center/IntegrationsPage.tsx`;
  - `src/renderer/control-center/integrations-settings-patch.ts`, con `createIntegrationsUpdater` construido sobre `createBlockUpdater`;
  - `src/renderer/notch/integration-visibility.ts`.
- Modificar en Control Center:
  - `src/renderer/control-center/ControlCenterApp.tsx`: la página `integrations` va después de `shortcut`, con el icono `Blocks` de lucide.
  - `src/renderer/control-center/{ClaudePage,GmailPage,CodeReviewPage,RedminePage,RemindersPage,SystemPage}.tsx`: si la integración está desactivada, arriba aparece la línea `cc.integrations.disabledNotice` con un botón de enlace que abre la página Integraciones. En «GitHub y GitLab» va una línea por cada plataforma desactivada.
- Modificar en el notch:
  - `src/renderer/notch/IntegrationRow.tsx`: oculta las casillas desactivadas y pinta los iconos con `--int`.
  - `src/renderer/notch/NotchApp.tsx`: bloques de cápsula, puntos de Claude, cierre de la vista desactivada, alertas y chimes.
  - `src/renderer/notch/system/CapsuleMetrics.tsx`: el icono de cada bloque con `--int`.
  - Raíz de cada vista con `style={integrationStyle(color)}`: `GmailView`, `ReviewsView` (según la plataforma), `RedmineView`, `NotesView`, `RemindersView` y `SystemView`.
  - Alertas (`MailAlert`, `ReviewAlert`, `RedmineAlert`, `ReminderAlert`, `claude/AlertCapsule`): icono en `text-[color:var(--int)]`; el punto coral de «te necesita» se mantiene.
  - `gmail/MessageList.tsx:98`: punto de no leído en `bg-[color:var(--int)]`.
  - `notes/NoteList.tsx:50`: chincheta en `--int`.
  - Confirmaciones de éxito de Redmine y Notas en `--int`.
- Tests: `tests/unit/renderer/integration-visibility.test.ts` y `tests/unit/renderer/integrations-settings-patch.test.ts` (nuevos).

**Interfaces:**
- **Consume** de las Tasks 1 y 3: `useIntegration`, `integrationStyle`, `ColorSwatchPicker` y `cloneDefaultIntegrations`.
- **Produce** en `integration-visibility.ts` (funciones puras):
  - `visibleTiles(tiles: readonly Tile[], integrations: IntegrationsSettings): Tile[]`: Terminal siempre; Claude según `claude.enabled`; las casillas de revisión según su plataforma; las de vista según su clave.
  - `capsuleShows(key: CapsuleIntegrationKey, integrations): boolean`, que vale `enabled && capsule`.
  - `viewAllowed(view: NotchView, integrations): boolean`. Si da `false`, `NotchApp` despacha la vuelta a `home`.
  - `alertAllowed(kind: 'mail'|'review-github'|'review-gitlab'|'redmine'|'reminder'|'claude', integrations): boolean`.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `integration-visibility.test.ts`:
    - con todo activado salen las 9 casillas, en el orden del registro;
    - con `gmail.enabled=false` salen 8, sin `gmail`;
    - con `system.enabled=false` desaparece su casilla, pero `capsuleShows` no depende de `system`;
    - `capsuleShows('gmail')` es false si `capsule=false`, aunque esté activada;
    - `viewAllowed('gmail')` es false si está desactivada;
    - `viewAllowed('reviews')` es true mientras quede una plataforma activa;
    - `alertAllowed('review-gitlab')` sigue a `gitlab.enabled`.
  - `integrations-settings-patch.test.ts`: dos cambios rápidos seguidos (el color de Gmail y luego el `enabled` de GitHub) dan dos parches por clave que no se pisan. Mismo patrón que `settings-block-patch.test.ts`.
- [ ] **Paso 2:** `npx vitest run tests/unit/renderer/integration-visibility.test.ts tests/unit/renderer/integrations-settings-patch.test.ts` → FAIL.
- [ ] **Paso 3: implementar.**
  - Página: una tabla de 4 columnas.
    - Integración: el icono en su color y el nombre.
    - Activa: `Switch`.
    - Cápsula: `Switch` en las 5 que la admiten, deshabilitado mientras la integración está desactivada. En Sistema, el texto `cc.integrations.always`; vacío en Recordatorios y Notas.
    - Color: `ColorSwatchPicker`.
  - La tabla usa `.card` y divisores `border-line`.
  - Después, los efectos en el notch según «Archivos».
- [ ] **Paso 4:** `npx vitest run`, `npm run typecheck`, `npm run lint` y `npm run build:tauri-renderer` → PASS.
- [ ] **Paso 5: commit** `feat(integrations): página Integraciones y color y visibilidad en el notch`.

### Task 5: Pausar y reanudar Gmail, revisiones y Redmine

**Archivos:**
- Modificar: `src-tauri/src/gmail/integration.rs`, `src-tauri/src/code_review/integration.rs`, `src-tauri/src/redmine/integration.rs` y `src-tauri/src/redmine/end_of_day.rs`
- Modificar: `src-tauri/src/lib.rs`, con un listener de `SettingsStore::on_change` que compara `prev.integrations` con `next.integrations` y llama a `set_enabled`. También aplica el estado inicial al arrancar.
- Tests: `src-tauri/src/gmail/integration_tests.rs`, `code_review/integration_tests.rs`, `redmine/integration_tests.rs` y `redmine/end_of_day_tests.rs`

**Interfaces (produce):**
- `GmailIntegration::set_enabled(&self, enabled: bool)`:
  - con `false`, llama a `clear_timer` y marca la integración como pausada (`can_poll()` pasa a false). Descarta la respuesta en vuelo: antes de aplicar o anunciar, comprueba `enabled`;
  - con `true`, consulta de inmediato y vuelve al ritmo normal;
  - esta pausa no es `dispose`, que sigue siendo definitivo.
- `CodeReviewIntegration::set_enabled(&self, platform: Platform, enabled: bool)`: lo mismo por plataforma, para revisiones y contribuciones.
- `RedmineIntegration::set_enabled(&self, enabled: bool)`: lo mismo para tareas y resumen.
- `EndOfDay::check` no ofrece el aviso si `integrations.redmine.enabled` es false.
- Al arrancar, una integración desactivada en los ajustes no hace ninguna consulta.

- [ ] **Paso 1: escribir las pruebas Rust que fallan**, con los dobles de reloj y cliente que ya tienen los `*_tests.rs`.
  - Gmail:
    - `disabled_gmail_does_not_poll_or_announce`;
    - `disabling_mid_poll_discards_response`: una respuesta que llega después de `set_enabled(false)` no se anuncia ni se publica;
    - `reenabling_polls_immediately`.
  - Revisiones: `disabled_platform_stops_reviews_and_contributions`; la otra plataforma sigue intacta.
  - Redmine: `disabled_redmine_does_not_poll`, `end_of_day_skipped_when_redmine_disabled`.
- [ ] **Paso 2:** `cargo test --manifest-path src-tauri/Cargo.toml gmail:: code_review:: redmine::` → FAIL.
- [ ] **Paso 3: implementar** y conectar el listener en `lib.rs`.
- [ ] **Paso 4:** `npm run test:rust` → PASS; `npx vitest run` → PASS.
- [ ] **Paso 5: commit** `feat(integrations): pausar y reanudar Gmail, revisiones y Redmine`.

### Task 6: Claude sin intercepción y recordatorios sin aviso

**Archivos:**
- Modificar: `src-tauri/src/claude/service.rs`:
  - añadir `set_intercept(&self, on: bool)`;
  - en `on_event`, antes de retener (`service.rs:577-582`), si no intercepta llamar a `release_reply(&*reply, route)`, igual que cuando está parado;
  - al pasar a `false`, llamar a `release_all()`.
- Modificar: `src-tauri/src/lib.rs`:
  - en el listener de la Task 5, `claude.enabled` llama a `set_intercept`;
  - en la emisión de recordatorios (`lib.rs:~564-590`), `set_due`, `emit_fired` y el toast solo se ejecutan si `reminders.enabled` es true.
- Tests: `src-tauri/src/claude/service/tests.rs` y `src-tauri/src/reminders/runtime/tests.rs` (o donde vivan `set_due` y `emit_fired`; si están solo en `lib.rs`, extraer una función pura `should_alert_reminder(settings) -> bool` y probarla).

**Interfaces (produce):**
- `ClaudeService::set_intercept(&self, on: bool)`: `true` por defecto; al arrancar se lee de `settings.integrations.claude.enabled`.

- [ ] **Paso 1: escribir las pruebas que fallan.**
  - `permission_passes_through_when_not_intercepting`: con `set_intercept(false)`, un `PermissionRequest` en `/hook` recibe `send(None)` de inmediato y `pending()` queda vacío.
  - `question_passes_through_when_not_intercepting`: en `/hook/question` recibe `send(Some("{}"))`.
  - `turning_off_releases_pending`: con un permiso retenido, tras `set_intercept(false)` el reply ha recibido `None`.
  - `turning_on_holds_again`.
  - Recordatorios: `due_reminder_does_not_alert_when_disabled`, sin toast ni evento.
- [ ] **Paso 2:** `cargo test --manifest-path src-tauri/Cargo.toml claude:: reminders::` → FAIL.
- [ ] **Paso 3: implementar.**
- [ ] **Paso 4:** `npm run test:rust` → PASS.
- [ ] **Paso 5: commit** `feat(integrations): Claude sin intercepción y recordatorios sin aviso al desactivar`.

### Task 7: E2E, DESIGN.md y verificación final

**Archivos:**
- Crear: `tests/e2e-tauri/integrations.spec.ts`
- Modificar: `DESIGN.md` (Control Center → Integraciones, color por integración y paleta con los hex ajustados) y la spec (Salmón `#FDA4AF` y Arcilla `#CC785C`, con el motivo)

- [ ] **Paso 1: escribir la e2e** `integrations.spec.ts`, en español:
  - `turning Gmail off hides its tile and capsule block and persists`: en Control Center → Integraciones, apagar Gmail. Comprobar que el panel muestra 8 casillas, sin `integration-gmail`, y que `settings.json` tiene `integrations.gmail.enabled=false`. Tras relanzar con `launch()`, sigue apagada.
  - `color picker by keyboard`: Tab hasta «Cambiar color», Enter, → dos veces y Esc. El color guardado es el segundo después del actual y el foco vuelve al botón.
  - `disabling an integration with its view open returns home`: abrir la vista Notas, apagar Notas desde Control Center y comprobar que el notch vuelve a `home`.
  - `claude off passes permissions through`: con Claude apagado, un POST de `PermissionRequest` al bridge responde enseguida con el cuerpo vacío, como en `claude.spec.ts`.
- [ ] **Paso 2: e2e completa.** Pedir al usuario que cierre la Developer Notch instalada y ejecutar `npm run test:e2e` → PASS. Antes de dar por buenas las pruebas inestables conocidas (`system.spec`, «closes a busy process», y Gmail), repetirlas por separado.
- [ ] **Paso 3: verificación final:** `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build:tauri-renderer` y `npm run test:rust`.
- [ ] **Paso 4: commit** `docs(design): integraciones configurables y paleta ajustada`.
