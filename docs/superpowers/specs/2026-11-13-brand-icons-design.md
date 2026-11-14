# Iconos de marca monocromos (Gmail, GitHub, Claude) — Diseño

**Fecha:** 2026-11-13 · **Rama:** la actual (`dev`; el usuario decide la rama y el PR)
**Fuentes:** `DESIGN.md` (tema Obsidian), `src/renderer/notch/code-review/icons.ts`.

## Objetivo

Que Gmail, GitHub y Claude se reconozcan por su marca en el notch y en Control Center, sin romper la regla del tema: los iconos siguen siendo monocromos y heredan el color de su sitio.

## Decisiones (tomadas con el usuario)

El usuario vio varias opciones de cada icono a 16, 13 y 32 px sobre el fondo del notch (también logos oficiales a color) y eligió todo monocromo:

| Servicio | Icono elegido | Fuente / licencia |
|---|---|---|
| Terminal | Sin cambio (Lucide `SquareTerminal`) | Lucide, ISC |
| Gmail | La "M" de Gmail, rellena | Simple Icons `gmail`, CC0 |
| GitHub | Invertocat relleno (sustituye al gato en trazo) | Simple Icons `github`, CC0 |
| GitLab | Sin cambio (Tanuki en trazo, `GitlabMark`) | marca que Lucide distribuía, ISC |
| Claude | El destello de Claude, relleno | Simple Icons `claude`, CC0 |
| Recordatorios, Sistema, Notas, Revisiones | Sin cambio (Lucide) | Lucide, ISC |

Descartado: los logos oficiales a color (Gmail de 4 colores, Tanuki tricolor, Windows Terminal, destello terracota) y Fluent Emoji para las demás baldosas.

## Alcance (aprobado: "en todos los sitios")

Los iconos heredan `currentColor`, así que el color de cada sitio no cambia:

- **M de Gmail** sustituye a `Mail` en: la baldosa Gmail (`IntegrationRow`), el bloque de correo de la cápsula (`CapsuleMail`), el aviso de correo nuevo (`MailAlert`, Azul Hielo) y el menú de Control Center (página Gmail).
- **Destello de Claude** sustituye a `MessagesSquare` en la baldosa Claude y a `Bot` en el aviso de Claude (`AlertCapsule`, sigue en Ámbar Espera) y en el menú de Control Center (página Claude).
- **Invertocat relleno** sustituye a `GithubMark` (trazo) en `PLATFORM_ICONS`: bloque de revisiones de la cápsula y aviso de revisión.

No cambian: los iconos que expresan un estado (p. ej. `Mail` en "Gmail sin configurar" de `GmailStatus`, `MailWarning`, `Inbox`), la baldosa Revisiones y el `GitPullRequest` del menú de Control Center y del aviso de revisión sin plataforma, y los tamaños (16 px en baldosas, 13 px en avisos, 12 px en la cápsula), así que la fila de 7 baldosas no se ensancha.

## Enfoques considerados

1. **`createLucideIcon` con trazos rellenos** (elegido): el mismo patrón que `code-review/icons.ts`. Cada `path` lleva `fill="currentColor"` y `stroke="none"`; el resultado es un `LucideIcon`, así que ningún tipo ni ninguna llamada cambia (`size`, `className`, `aria-hidden` funcionan igual; `strokeWidth` no afecta). Simple Icons usa la rejilla de 24×24 de Lucide.
2. SVG sueltos importados con `?raw` o como `<img>`: no heredan `currentColor` (con `<img>`) o obligan a `dangerouslySetInnerHTML`. Descartado.
3. `vite-plugin-svgr`: una dependencia nueva para tres iconos. Descartado.

## Diseño

- Nuevo módulo `src/renderer/shared/brand-icons.ts` con `GmailMark`, `GithubMark` (Invertocat relleno), `GitlabMark` (movido sin cambios desde `code-review/icons.ts`) y `ClaudeMark`, cada uno con un comentario de fuente y licencia. `code-review/icons.ts` conserva `PLATFORM_ICONS` importando de ahí.
- Los `path` se copian tal cual de Simple Icons 13.21.0 (`icons/gmail.svg`, `icons/github.svg`, `icons/claude.svg`).
- Atribución: `THIRD_PARTY_NOTICES.md` en la raíz (Simple Icons CC0, marcas de Lucide ISC, y la nota de que los logos son marcas registradas de sus dueños y se usan solo para identificar el servicio).
- `DESIGN.md`: la regla de iconos pasa a "Lucide con trazo de 1.8 px, salvo las marcas de servicio (Gmail, GitHub, GitLab, Claude), que son monocromas y heredan el color de su sitio"; se actualizan las menciones a `Mail`, `Bot` y `Github` en las secciones afectadas.

## Pruebas

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` pasan.
- Prueba unitaria nueva: cada marca se pinta como `<svg>` con `fill="currentColor"` en sus `path` y respeta `size`.
- Revisión visual con capturas de Playwright de las ventanas de la app (baldosas a 16 px, cápsula a 12 px, avisos a 13 px), sin tocar el escritorio del usuario.

## Lo que queda al implementador

El orden de los cambios y el nombre exacto de la prueba unitaria.
