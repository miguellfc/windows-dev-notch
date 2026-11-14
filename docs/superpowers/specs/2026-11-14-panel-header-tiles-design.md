# Panel: baldosas GitHub y GitLab, botones de icono arriba y sin pie — Diseño

**Fecha:** 2026-11-14 · **Rama:** la actual (`dev`; el usuario decide la rama y el PR)
**Fuentes:** `DESIGN.md`, `docs/superpowers/specs/2026-11-13-brand-icons-design.md` (marcas monocromas), `src/renderer/notch/NotchApp.tsx` (`Panel`), `src/renderer/notch/IntegrationRow.tsx`, `src/renderer/notch/code-review/ReviewsView.tsx`, `src/shared/notch/geometry.ts`.

## Objetivo

Un panel más directo y compacto: cada plataforma de código con su propia baldosa, Control Center y Ocultar como iconos en la cabecera, y sin el pie de atajos.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Revisiones | Se divide en dos baldosas, **GitHub** (Invertocat relleno, `GithubMark`) y **GitLab** (Tanuki en trazo, `GitlabMark`); la baldosa "Revisiones" desaparece |
| Orden | Terminal, Recordatorios, Sistema, Notas, Gmail, GitHub, GitLab, Claude |
| Ancho | El panel expandido pasa de **440 a 480 px** (fila de 454 px) para que quepan las 8 baldosas con el aire actual |
| Vista de revisiones | **Sin pestañas**: cada baldosa abre la vista en su plataforma; la cabecera dice "GitHub" o "GitLab" |
| Control Center / Ocultar | Sin texto: botones de icono en la cabecera del panel, a la derecha de la fecha |
| Icono de Control Center | Lucide **`Cog`** (antes `SlidersHorizontal`); Ocultar sigue con `EyeOff` |
| Pie | Se elimina ("Esc para cerrar" + tecla del atajo); Esc sigue cerrando |

## Enfoques considerados

1. **Baldosas de "vista" con plataforma** (elegido): las baldosas GitHub y GitLab abren la integración `reviews` existente tras fijar la plataforma con `setReviewsTarget(...)` (el mismo mecanismo que usa el aviso de revisión). Sin IPC nuevo; `IntegrationId` no cambia.
2. Integraciones nuevas `github` y `gitlab` en el esquema de IPC y en el estado del notch: duplica la vista y su estado sin beneficio. Descartado.
3. Mantener 440 px apretando relleno y huecos: cabe (~390 px) pero los nombres quedan pegados al borde y no hay margen para idiomas más largos. Descartado; dos filas o baldosas sin nombre también se descartan (más alto / menos legible).

## Diseño

- **Registro de baldosas** (`src/shared/integrations/registry.ts`): la entrada `reviews` se sustituye por dos baldosas que abren la vista `reviews` con su plataforma (`github`, `gitlab`), con claves i18n `integration.github` = "GitHub" y `integration.gitlab` = "GitLab" (iguales en ES y EN). `data-testid` `integration-github` / `integration-gitlab`. La clave `integration.reviews` se elimina si queda sin uso.
- **Clic** en GitHub/GitLab: fija el objetivo de la vista a esa plataforma (sección por defecto, como al abrir sin aviso) y llama a `openIntegration({ id: 'reviews' })`.
- **ReviewsView**: sin `role="tablist"`/`tab`/`tabpanel` ni ←/→ entre plataformas. La plataforma es la del objetivo; si no hay objetivo (p. ej. tras recargar el renderer), la primera configurada o `github`. Si la plataforma elegida no está configurada, la vista muestra su estado "sin configurar" (ya no salta a la otra). La cabecera muestra el nombre de la plataforma (`PLATFORM_NAMES`) en lugar de "Revisiones", y el `aria-label` de la vista también. Contribuciones, listas, Actualizar, estados y teclado (flechas entre filas, Enter, Esc) no cambian.
- **Cabecera del panel** (`Panel` en `NotchApp.tsx`): hora a la izquierda; a la derecha la fecha y dos botones de icono de 28 px (`Cog` → `openControlCenter()`, `EyeOff` → `hideNotch()`), icono de 16 px en Grafito, hover y foco Tiza sobre Velo, radio `--radius-control-sm`, `aria-label` y `title` con `notch.panel.controlCenter` / `notch.panel.hide`, centrados en vertical en la cabecera.
- **Se eliminan** el `nav` de dos filas y el `footer`; la clave `notch.panel.escHint` se elimina si queda sin uso, y `Panel` deja de recibir `shortcut` si ya no lo usa.
- **Geometría** (`src/shared/notch/geometry.ts`): `CAPSULE_SIZES.expanded.width` = 480. `EXPANDED_HEIGHTS` baja: valores **medidos con Playwright** en la app (sin hueco ni recorte) para 0, 1 y ≥2 sesiones. `WINDOW_WIDTH` y la lógica de crecimiento de ventana siguen siendo válidos (el panel de permiso ya mide 480).
- **IntegrationRow**: comentario de anchos actualizado (8 baldosas, fila de 454 px, anchos medidos de etiquetas en ES/EN).
- **DESIGN.md**: panel de 480 px, cabecera con botones de icono, sin pie, baldosas GitHub/GitLab, vista de revisiones sin pestañas (cabecera con el nombre de la plataforma), icono `Cog`.

## Pruebas

- Unitarias: `notch-geometry.test.ts` con el nuevo ancho y alturas; pruebas del registro si las hay.
- e2e: "las ocho baldosas caben sin cortar nombres en ES y EN"; `code-review.spec.ts` abre por `integration-github`/`integration-gitlab`, sin pestañas; los botones de icono de la cabecera abren Control Center y ocultan; el pie no existe.
- `npm run typecheck` (salvo los 10 errores preexistentes en `tests/e2e`), `npm run lint`, `npm test`, `npm run test:e2e`; capturas de Playwright solo de las ventanas de la app.

## Lo que queda al implementador

La forma exacta del tipo de baldosa con plataforma, los valores medidos de `EXPANDED_HEIGHTS` y el orden de los cambios.
