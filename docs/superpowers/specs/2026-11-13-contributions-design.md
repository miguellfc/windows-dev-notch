# GitHub y GitLab en el notch — Hito 2: contribuciones — Diseño

**Fecha:** 2026-11-13 · **Rama:** `feat/contributions` (desde `dev`)
**Fuentes:** `docs/superpowers/specs/2026-11-13-code-review-design.md` (hito 1: conexión, tokens, vista "Revisiones"), `DESIGN.md`.

> **Cambio (2026-11-13, revisión final):** corregido en el sitio para reflejar lo implementado: rejilla de 4–6 columnas; rango de eventos de GitLab (`after` = min(día 1, lunes) − 2 días, `before` = hoy + 2 días, filtrado por fecha local); PR fusionados de GitHub con ISO local y desfase; rango de "hoy" nunca vacío; gráfico de GitLab con lista de acciones permitidas (como su calendario); línea del total "N contribuciones en el gráfico de <mes>" con la nota de GitLab; nivel 0 al 14 %; IPC (`code-review:view {open}`, `code-review:contributions` → `{summary, error}`, evento `code-review:contributions-changed {platform, error}`; la vista se cierra al recargar el renderer); panel de 520×560, el más alto (ventana de 638 px).

## Objetivo

Ver de un vistazo cuánto has contribuido este mes en cada plataforma, como en el perfil de GitLab: un gráfico de actividad del mes en curso y un resumen de hoy, la semana y el mes.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Dónde | Dentro de la vista **"Revisiones"**, al estilo del perfil de GitLab: **arriba el gráfico** (y el resumen), **abajo los PR/MR** del hito 1 |
| Plataformas | **Según la pestaña**: GitHub y GitLab tienen cada una su gráfico y su resumen |
| Gráfico | Solo el **mes en curso**, un cuadrado por día |
| Resumen | **Hoy · Semana · Mes**: commits, PR/MR abiertos, PR/MR fusionados, revisiones |

## Datos

### GitHub (GraphQL, mismo token y cliente del hito 1)

- `viewer { contributionsCollection(from: <día 1 del mes 00:00 local, en ISO>, to: <ahora>) { contributionCalendar { weeks { contributionDays { date contributionCount } } } totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount } }` para el mes; el mismo bloque con `from` = lunes de la semana y = hoy 00:00 (alias distintos) para semana y hoy. `to` = ahora, pero nunca igual a `from`: el rango de "hoy" nunca queda vacío (a las 00:00 exactas, `to` = hoy 00:00 + 1 s).
- **PR fusionados**: `search(type: ISSUE, query: "is:pr author:@me is:merged merged:>=<inicio>", first: 0) { issueCount }` con alias para hoy, semana y mes; `<inicio>` es la hora local de inicio del rango en ISO 8601 con su desfase (p. ej. `2026-11-13T00:00:00+01:00`), no una fecha sola, que GitHub interpretaría en UTC.
- Las contribuciones en repositorios a los que el token no llega no cuentan (con un token *fine-grained*, solo los repositorios elegidos). Si `restrictedContributionsCount > 0`, la vista lo indica en una línea ("Incluye contribuciones privadas que no se detallan").

### GitLab (REST v4, mismo token y cliente del hito 1)

- `GET /api/v4/users/:id/events?after=<min(día 1 del mes, lunes de la semana) − 2 días, YYYY-MM-DD>&before=<hoy + 2 días, YYYY-MM-DD>&per_page=100&page=N` (paginado hasta agotar, máximo **10 páginas**; si se alcanza el máximo, se indica "datos parciales"). `after`/`before` son exclusivos y GitLab los aplica en la zona horaria del **servidor** (UTC en gitlab.com): los dos días de margen a cada lado cubren cualquier desfase, y luego cada evento se filtra por la **fecha local** de su `created_at` (mes, semana y hoy).
- Clasificación por evento (fecha local de `created_at`):
  - **Commits**: `action_name` `pushed to` / `pushed new` → `push_data.commit_count`.
  - **MR abiertos**: `action_name: opened` y `target_type: MergeRequest`.
  - **MR fusionados**: `action_name: accepted` (o `merged`) y `target_type: MergeRequest`.
  - **Revisiones**: `action_name: approved` con `target_type: MergeRequest`, y `commented on` con `note.noteable_type: MergeRequest` (o `target_type: DiffNote`/`Note` sobre un MR).
  - **Gráfico**: como el calendario de GitLab, **un evento = una contribución** (un push cuenta 1 aunque lleve varios commits), con una **lista de acciones permitidas**: `pushed to`/`pushed new`, `commented on`, y `created`/`opened`, `closed`, `merged`/`accepted`, `approved` sobre `MergeRequest`, `Issue` o `WorkItem`. Todo lo demás (ediciones de wiki, proyecto creado, hito cerrado, `joined`/`left`/`expired`, `deleted`…) no es contribución. El **resumen**, en cambio, usa los recuentos por tipo de arriba (commits = suma de `commit_count`), sin cambios.

### Fechas

- Zona horaria **local** del equipo. Semana de **lunes a domingo**. Mes natural en curso. "Hoy" = desde las 00:00 locales.
- Al cambiar de día o de mes con la vista abierta, la siguiente consulta usa el nuevo rango.

### Ritmo

- Al **abrir la vista** y cada **15 min** mientras está abierta; con Actualizar (mínimo 5 s, el mismo botón de la vista). Nunca con la vista cerrada.
- Fallos: se conservan los últimos datos con "Actualizado hace N min"; error de red → "No se pudieron cargar las contribuciones · Reintentar"; 401/403 → el `auth-error` del hito 1 (toda la pestaña).

## Arquitectura

- **Main**:
  - `github-client.ts` gana `contributions(range): Promise<ContributionSummary>`; `gitlab-client.ts` igual, pidiendo las páginas de eventos en serie.
  - `contributions.ts` (puro): construcción de rangos (mes, semana, hoy) en hora local; rejilla del mes (semanas de lunes a domingo, días fuera del mes vacíos); clasificación y suma de eventos de GitLab; escala de nivel 0–4.
  - `code-review-integration.ts`: `contributions(platform)` con caché por plataforma, temporizador de 15 min solo con la vista abierta (la vista ya avisa al abrir y cerrar), y generación por token como el resto.
- **Modelo**:

```ts
ContributionDay = { date: string /* YYYY-MM-DD */; count: number; level: 0 | 1 | 2 | 3 | 4; inMonth: boolean; future: boolean }
ContributionTotals = { commits: number; opened: number; merged: number; reviews: number }
ContributionSummary = {
  month: string                 // YYYY-MM
  weeks: ContributionDay[][]    // 4–6 columnas × 7 filas (lunes→domingo)
  monthTotal: number            // contribuciones del mes (suma del gráfico)
  activeDays: number
  today: ContributionTotals; week: ContributionTotals; monthTotals: ContributionTotals
  partial: boolean              // GitLab: se alcanzó el máximo de páginas
  restricted: boolean           // GitHub: hay contribuciones privadas no detalladas
  updatedAt: string
}
```

- **IPC** (solo notch, zod de entrada y salida): `code-review:contributions { platform }` → `{ summary: ContributionSummary | null, error: boolean }` (`summary` null si la plataforma no está configurada o sin datos todavía; `error` si la última consulta falló, conservando el último resumen bueno); `code-review:view { open: boolean }` avisa al abrir y cerrar la vista y activa o para el temporizador de 15 min; evento main → notch `code-review:contributions-changed { platform, error }` cuando cambian las contribuciones de una plataforma (el notch vuelve a leerlas con `code-review:contributions`); evento `code-review:state` sin cambios. Si el renderer del notch se recarga, la vista cuenta como cerrada (se para el temporizador).

## Vista "Revisiones"

- Debajo de la cabecera y las pestañas:
  - **Gráfico**: 7 filas (lun→dom) × 4–6 columnas (una por semana); cuadrados de ~14 px con 3 px de separación; nivel 0 = Grafito al 14 % (subido del 8 % en la revisión: se confundía con el borde de los días futuros), niveles 1–4 en tonos de azul hielo; días fuera del mes ocultos; días futuros sin relleno; hoy con borde. Hover/foco: "12 nov · 7 contribuciones". Etiquetas de los siete días (L M X J V S D) a la izquierda y del mes arriba.
  - **Resumen**: tabla compacta con columnas **Hoy · Semana · Mes** y filas **Commits · PR abiertos · PR fusionados · Revisiones** (en GitLab "MR"), cifras tabulares; "—" sin dato. Debajo: "84 contribuciones en el gráfico de noviembre" (en GitLab, con la nota "En el gráfico un push cuenta 1; el resumen cuenta commits") y "Actualizado hace 3 min"; las líneas de "datos parciales"/"privadas" cuando aplique.
  - Gráfico y resumen lado a lado si caben; si no, el resumen debajo (decidido con capturas).
- **Debajo**: "Por revisar" y "Míos" como en el hito 1, con su propio desplazamiento.
- **Tamaño**: el panel mide **520×560**, medido con capturas; es el **más alto** (ventana de 638 px): la ventana crece antes de abrirlo y se encoge al cerrarlo (como la tarjeta de preguntas).
- **Estados**: cargando (rejilla en gris, sin animación con `prefers-reduced-motion`), error con Reintentar, sin configurar / revisa el token (como el hito 1).
- **Accesibilidad**: el gráfico es una tabla (`role="grid"` o `<table>`) con cabeceras de día y semana; cada celda con su etiqueta; un resumen textual para lectores de pantalla ("Noviembre: 84 contribuciones en 15 días activos"). Teclado: Tab entra al gráfico, flechas entre días, Tab sale hacia las listas.
- i18n ES/EN (nombres de días y meses con `Intl`); tokens de `DESIGN.md`.

## Seguridad y privacidad

Sin cambios respecto al hito 1: mismo token, mismos orígenes, sin redirecciones. Las contribuciones solo viven en memoria; el log solo lleva recuentos y códigos (nunca nombres de repositorios ni títulos de eventos).

## Coste

GitHub: 1 consulta GraphQL más al abrir la vista y cada 15 min con ella abierta. GitLab: 1–10 páginas de eventos en serie con la misma frecuencia.

## Pruebas

- **Unitarias**: rangos (mes de 28/29/30/31 días, mes que empieza en domingo o lunes, semana que cruza el cambio de mes, zona horaria con cambio de horario, hoy); rejilla (columnas y días fuera del mes); niveles 0–4 (todo a 0, un solo día, máximos repetidos); clasificación de eventos de GitLab (cada tipo, comentario en issue que no es revisión, push con `commit_count`); paginación y límite de 10 páginas (`partial`); GitHub (mapeo de `contributionCalendar`, totales, PR fusionados, `restricted`); integración (caché, 15 min solo con la vista abierta, errores, generación por token); guards IPC.
- **E2E** con el servidor falso ampliado (calendario de GitHub y eventos de GitLab): gráfico con el número de días del mes y los niveles esperados, resumen con las cifras esperadas por pestaña, Reintentar tras un error, capturas ES/EN de la vista con gráfico y listas.

## Criterios de aceptación

1. Al abrir "Revisiones", cada pestaña muestra el gráfico del mes en curso y el resumen de hoy, semana y mes de esa plataforma.
2. Los recuentos coinciden con los del servidor (calendario de GitHub; eventos de GitLab del mes).
3. Las listas de PR/MR siguen funcionando aunque fallen las contribuciones.
4. Sin consultas de contribuciones con la vista cerrada.
5. Nada de contribuciones en el log ni en disco.

## Fuera de alcance

Meses anteriores o el año completo; gráfico combinado de las dos plataformas; contribuciones por repositorio; rachas; contribuciones en la cápsula.
