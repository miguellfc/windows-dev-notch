# GitHub y GitLab en el notch — Hito 1: PR/MR — Diseño

**Fecha:** 2026-11-13 · **Rama:** `feat/code-review`
**Fuentes:** PRD ("integraciones vivas"), `DESIGN.md`, patrón de Gmail (token cifrado, cliente REST con zod, integración con ritmo y espera creciente, avisos en la cápsula).

## Objetivo

Ver de un vistazo cuántos PR (GitHub) y MR (GitLab) tuyos siguen sin revisar, enterarte cuando alguien revisa uno, y tener a mano los que esperan tu revisión y los tuyos abiertos.

## Alcance y división (decidido con el usuario)

1. **Hito 1** (este spec): conexión de GitHub (github.com) y de un **GitLab propio** (self-hosted); contadores y avisos en la cápsula; vista con los PR/MR.
2. **Hito 2**: contribuciones — gráfico de actividad **del mes en curso** y resumen de **hoy, semana y mes** (commits, PR/MR abiertos y fusionados, revisiones). Spec propio.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Servidores | **github.com** + **GitLab propio** (URL configurable, solo `https`) |
| Conexión | **Tokens personales** de solo lectura, cifrados con `safeStorage` (DPAPI); sin OAuth |
| Cápsula | **Por plataforma**: icono + número de **tus PR/MR abiertos sin revisar** |
| Aviso | **Por plataforma**, cuando un PR/MR **tuyo recibe su primera revisión** (aprobado, cambios pedidos o comentado) |
| Vista | Pestañas GitHub \| GitLab; secciones "Por revisar" (te piden revisión) y "Míos" (tuyos abiertos) |

## Definiciones

- **Sin revisar** (contador): PR/MR **tuyo, abierto, no borrador** y sin ninguna revisión.
  - GitHub: ninguna revisión enviada (`reviews.totalCount === 0`: ni aprobación, ni cambios pedidos, ni comentario de revisión).
  - GitLab: sin aprobaciones (`approved_by` vacío) y sin revisores con estado `reviewed`/`requested_changes` (cuando el servidor expone el estado de los revisores; si no, solo aprobaciones).
- **Primera revisión** (aviso): un PR/MR tuyo que estaba "sin revisar" en la consulta anterior y ya no lo está (y sigue abierto). El aviso dice el tipo: **Aprobado**, **Cambios pedidos** o **Revisado**.

## Configuración por el usuario

Guía `docs/code-review-setup.md`:

- **GitHub**: token *fine-grained* de solo lectura (Settings → Developer settings) con lectura de "Pull requests", "Metadata" y "Commit statuses"/"Checks". Advertencias: solo ve los repositorios elegidos al crearlo; en organizaciones puede necesitar aprobación de un administrador; alternativa: token *clásico* con permiso `repo` (ve todo, pero también permite escribir).
- **GitLab**: URL del servidor y token personal con permiso `read_api` (Preferences → Access tokens).
- Los tokens caducan cuando el usuario decide; el notch muestra "Revisa el token" al recibir 401/403.

## Arquitectura

### Main (`src/main/code-review/`)

- **`github-client.ts`**: `POST https://api.github.com/graphql` con `Authorization: Bearer <token>`. Una consulta con dos búsquedas (`is:open is:pr review-requested:@me archived:false` y `is:open is:pr author:@me archived:false`, hasta 20 cada una) y `viewer { login }`. Por PR: id, número, título, repo (`owner/name`), URL, autor, `isDraft`, `updatedAt`, `reviewDecision`, `reviews(first:1){ totalCount }` y el último review (estado), `mergeable`, estado de checks (`commits(last:1){ nodes { commit { statusCheckRollup { state } } } }`). Respuesta validada con zod.
- **`gitlab-client.ts`**: `GET <url>/api/v4/user` (cuenta e id), `GET <url>/api/v4/merge_requests?state=opened&reviewer_id=<id>&scope=all&per_page=20` y `…?state=opened&scope=created_by_me&per_page=20`; por cada MR propio, `GET …/projects/:id/merge_requests/:iid/approvals`. Cabecera `PRIVATE-TOKEN`. Datos por MR: id, iid, título, `references.full`, `web_url`, autor, `draft`, `updated_at`, `has_conflicts`, `detailed_merge_status`, estado de la pipeline si viene (`head_pipeline.status`), aprobaciones. Validado con zod.
- **`review-detector.ts`** (puro): `observe(own: { id, reviewed: ReviewKind | null }[]) → { id, kind }[]` con los que pasan de sin revisar a revisados; la primera observación tras `reset()` solo guarda la referencia. `ReviewKind = 'approved' | 'changes' | 'commented'`.
- **`code-review-integration.ts`**: por plataforma: estado `unconfigured | ok | offline | auth-error`, cuenta, contador, listas, `updatedAt`. Consulta cada **120 s** en cualquier modo de la cápsula (para que el aviso funcione siempre), al momento al abrir la vista o con Actualizar (mínimo 5 s), y espera creciente ante fallos (1 → 2 → 4 → 5 min). 401/403 → `auth-error` y deja de consultar esa plataforma hasta que se guarde otro token. El detector se reinicia al cambiar el token o la URL.
- **Tokens**: `userData/code-review-github.bin` y `code-review-gitlab.bin`, cifrados con `safeStorage` (como `token-store.ts` de Gmail); sin cifrado disponible solo viven en memoria. Nunca llegan al renderer ni al log.
- **Abrir en el navegador**: main abre con `shell.openExternal` solo URLs de la última lista enviada y cuyo origen sea `https://github.com` o el origen configurado de GitLab.

### Ajustes

`settings.json` pasa a la **versión 6** (migración 5 → 6):

```ts
codeReview: {
  gitlabUrl: string          // '' = sin configurar; solo https
  alerts: {
    github: { enabled: boolean; sound: boolean }   // por defecto true / true
    gitlab: { enabled: boolean; sound: boolean }
  }
}
```

### IPC

| Canal / evento | Entrada | Salida | Quién |
|---|---|---|---|
| evento `code-review:state` | — | `{ github: PlatformState, gitlab: PlatformState }` (estado, cuenta, contador, `updatedAt`) | main → notch y Control Center |
| `code-review:get-state` | — | igual | notch y Control Center |
| `code-review:list` | `{ platform }` | `{ toReview: Item[], mine: Item[] }` (≤ 20 cada una) | solo notch |
| `code-review:refresh` | — | `null` | solo notch |
| `code-review:open` | `{ platform, id }` | `null` | solo notch; id de la última lista |
| `code-review:set-token` | `{ platform, token, url? }` | `{ ok: true, account } \| { ok: false, reason: 'auth' \| 'network' \| 'url' }` (valida contra la API antes de guardar) | solo Control Center |
| `code-review:clear` | `{ platform }` | `null` | solo Control Center |
| evento `code-review:alert` | — | `{ platform, count, kind?, ref?, title? }` | main → notch |

`Item = { id, ref /* owner/repo#123 o group/project!45 */, title, author, updatedAt, draft, review: 'none' | 'approved' | 'changes' | 'commented', checks: 'pass' | 'fail' | 'running' | null, conflicts: boolean }`. Todo con `registerIpc`, guards y zod de entrada y salida.

### Notch

- **Cápsula**: después del correo, un bloque por plataforma configurada con contador > 0: icono (Lucide `Github` / `Gitlab`) + número (`99+` a partir de 100), Grafito Cristal, tabular, con el latch de la cápsula. Etiqueta accesible: "2 PR tuyos sin revisar en GitHub" / "2 MR tuyos sin revisar en GitLab". Anchos añadidos a `COMPACT_WIDTHS`, medidos en ES/EN con el peor caso (dos bloques `99+` con correo, disco y batería).
- **Aviso** (`alert`, misma prioridad que el correo — la más baja —, 6 s, también en `mini`/`hidden`, sin robar el foco): icono de la plataforma + "**Aprobado** · *repo*#123 · título" (o **Cambios pedidos** / **Revisado**); varios a la vez: "**2 PR revisados** · GitHub" / "**2 MR revisados** · GitLab". Sonido con el `chime` si está activado. Clic → vista en esa plataforma, sección "Míos".
- **Vista "Revisiones"** (casilla nueva en la fila de integraciones, icono `GitPullRequest`; la fila pasa a 6 casillas y se mide que quepa):
  - Cabecera: ←, "Revisiones", pestañas GitHub \| GitLab (solo las configuradas), Actualizar.
  - Secciones **Por revisar** y **Míos**; filas con `ref` y título (una línea), autor (en "Por revisar") y hace cuánto se actualizó, y etiquetas: Borrador, Aprobado, Cambios pedidos, Sin revisar (en "Míos"), Conflictos, Checks ✓ / ✗ / en curso.
  - Clic o Enter → `code-review:open`.
  - Estados: sin configurar (botón a Control Center), "Revisa el token en Control Center" (`auth-error`), sin conexión (últimos datos atenuados), vacío ("Nada pendiente").
  - Teclado: flechas entre filas, ←/→ entre pestañas, Enter abre, Esc vuelve.
  - Tamaño medido con capturas.
- i18n ES/EN; tokens de `DESIGN.md`; textos de títulos siempre como texto.

### Control Center

Nueva página **"GitHub y GitLab"** (después de Gmail): tarjeta por plataforma con campo de token (`type="password"` con mostrar/ocultar), URL del servidor (GitLab), **Comprobar y guardar** (muestra la cuenta o el error), **Quitar**, y los interruptores de avisos y sonido; pasos breves y la ruta de la guía.

## Seguridad y privacidad

1. Tokens solo en main y en disco cifrados con DPAPI; nunca en el renderer ni en el log.
2. La URL de GitLab debe ser `https`; los tokens solo se envían a `api.github.com` y al origen configurado de GitLab.
3. Solo se abren en el navegador URLs de la última lista y de esos orígenes.
4. Títulos, nombres de repositorios y autores solo en memoria; nunca en disco ni en el log (solo recuentos, estados y códigos).
5. Canales de lectura solo desde el notch; los de tokens solo desde Control Center.

## Coste

GitHub: 1 consulta GraphQL cada 2 min (muy por debajo de 5000 puntos/h). GitLab: 3 + N llamadas cada 2 min (N = MR propios abiertos, ≤ 20).

## Pruebas

- **Unitarias**: clientes con respuestas simuladas (GraphQL y REST; esquemas; 401/403/429/5xx; red caída); definición de "sin revisar"; detector (sin revisar → aprobado / cambios / comentado; primera observación; varios; cerrados que desaparecen no avisan); integración (ritmo, espera creciente, `auth-error`, reinicio del detector al cambiar el token); validación de URL `https`; guards IPC; migración 5 → 6; estado del notch y anchos de la cápsula.
- **E2E** con un servidor falso de GitHub GraphQL y de GitLab REST: guardar tokens en Control Center; contadores en la cápsula; vista con pestañas y secciones; abrir en el navegador (URL capturada); un PR pasa a aprobado → aviso; token inválido → "Revisa el token"; capturas ES/EN.
- **Manual (usuario)**: con sus tokens reales.

## Criterios de aceptación

1. Con los tokens guardados, la cápsula muestra por plataforma el número de PR/MR propios sin revisar en ≤ 2 min.
2. Cuando alguien revisa un PR/MR propio, aparece el aviso en ≤ 2 min, también con la cápsula en `mini` u oculta.
3. La vista lista lo que espera tu revisión y lo tuyo abierto, con su estado, y abre cada uno en el navegador.
4. Un token caducado se muestra como "Revisa el token", nunca como un fallo silencioso.
5. Ningún token ni título aparece en el log ni en disco sin cifrar.

## Fuera de alcance (de este hito)

Contribuciones (hito 2); acciones (aprobar, fusionar, relanzar pipelines); notificaciones y menciones; varias cuentas o servidores por plataforma; GitHub Enterprise; OAuth.
