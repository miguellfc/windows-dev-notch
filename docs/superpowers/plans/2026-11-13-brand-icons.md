# Iconos de marca monocromos — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustituir los iconos genéricos de Gmail, GitHub y Claude por sus marcas monocromas (Simple Icons, CC0), que heredan el color de su sitio.

**Architecture:** Un módulo `src/renderer/shared/brand-icons.ts` crea cada marca con `createLucideIcon` (trazos con `fill="currentColor"`, `stroke="none"`), así que son `LucideIcon` y sustituyen a los iconos actuales sin cambiar tipos ni llamadas.

**Tech Stack:** Electron 45, React 19, TypeScript, lucide-react 1.x, Vitest, Playwright `_electron`.

**Spec:** `docs/superpowers/specs/2026-11-13-brand-icons-design.md`

## Global Constraints

- Sin dependencias nuevas; no se toca `eslint.config.mjs`.
- Los `d` de los `path` se copian literalmente de Simple Icons 13.21.0: `https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/{gmail,github,claude}.svg` (viewBox 0 0 24 24).
- Tamaños sin cambio: 16 px baldosas, 13 px avisos, 12 px cápsula; colores sin cambio (heredan `currentColor`).
- No se commitea nada sin aprobación del usuario: el cambio queda sin commitear al final.

## Review Focus

- Instancias repetidas del mismo icono en una página (cápsula + aviso): sin `id` internos que choquen → las marcas no usan `id`, gradientes ni máscaras (prueba de Task 1).
- `strokeWidth={1.8}` que pasan los llamadores no debe engordar las marcas rellenas → `stroke="none"` en cada `path` (prueba de Task 1).
- Legibilidad a 12 px en la cápsula (la M y el destello son detallados) → captura en Task 3.
- Fila de 7 baldosas en ES: no debe ensancharse (404/414 px) → captura en Task 3.
- El aviso de Claude sigue en Ámbar Espera (estado real) → se conserva `text-wait` (Task 2).

---

### Task 1: Módulo de marcas y atribución

**Files:**
- Create: `src/renderer/shared/brand-icons.ts`
- Modify: `src/renderer/notch/code-review/icons.ts` (quita `GithubMark`/`GitlabMark`; `PLATFORM_ICONS` importa de `brand-icons`)
- Create: `THIRD_PARTY_NOTICES.md`
- Test: `tests/unit/renderer/brand-icons.test.ts`

**Interfaces:**
- Produces: `export const GmailMark: LucideIcon`, `GithubMark: LucideIcon` (Invertocat relleno), `GitlabMark: LucideIcon` (el trazo de hoy, movido sin cambios), `ClaudeMark: LucideIcon`; `PLATFORM_ICONS` sigue exportándose desde `code-review/icons.ts` con la misma firma.

- [ ] **Step 1: Write the failing test** (`renderToStaticMarkup` de `react-dom/server` + `createElement`)

```ts
describe.each([['GmailMark', GmailMark], ['GithubMark', GithubMark], ['ClaudeMark', ClaudeMark]])('%s', (_, Icon) => {
  const html = renderToStaticMarkup(createElement(Icon, { size: 13, strokeWidth: 1.8, 'aria-hidden': 'true' }))
  it('is a 24×24 svg at the requested size', () => {
    expect(html).toMatch(/^<svg[^>]*width="13"[^>]*height="13"/)
    expect(html).toContain('viewBox="0 0 24 24"')
  })
  it('fills every path with currentColor and no stroke', () => {
    const paths = html.match(/<path[^>]*>/g) ?? []
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) { expect(p).toContain('fill="currentColor"'); expect(p).toContain('stroke="none"') }
  })
  it('has no internal ids', () => { expect(html).not.toMatch(/\sid="/) })
})
it('GitlabMark keeps the stroked outline', () => {
  expect(renderToStaticMarkup(createElement(GitlabMark))).not.toContain('fill="currentColor"')
})
it('PLATFORM_ICONS maps to the brand marks', () => {
  expect(PLATFORM_ICONS).toEqual({ github: GithubMark, gitlab: GitlabMark })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/renderer/brand-icons.test.ts`
Expected: FAIL (no se resuelve `src/renderer/shared/brand-icons`).

- [ ] **Step 3: Implement `brand-icons.ts`**: cada marca con `createLucideIcon('<nombre>-mark', [['path', { d, fill: 'currentColor', stroke: 'none', key }]])`; comentario por marca con fuente, versión y licencia (CC0 para Simple Icons; ISC para `GitlabMark`). Reducir `icons.ts` a `PLATFORM_ICONS`.

- [ ] **Step 4: Write `THIRD_PARTY_NOTICES.md`**: Simple Icons 13.21.0 (CC0 1.0; `gmail`, `github`, `claude`), marca de GitLab que distribuía Lucide (ISC), y la nota "Gmail, GitHub, GitLab y Claude son marcas de sus respectivos dueños; se usan solo para identificar el servicio".

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run tests/unit/renderer/brand-icons.test.ts && npm run typecheck`
Expected: PASS, sin errores de tipos.

### Task 2: Sustituir los usos y actualizar DESIGN.md

**Files:**
- Modify: `src/renderer/notch/IntegrationRow.tsx` (`gmail: GmailMark`, `claude: ClaudeMark`)
- Modify: `src/renderer/notch/system/CapsuleMetrics.tsx` (`CapsuleMail`: `icon={GmailMark}`)
- Modify: `src/renderer/notch/gmail/MailAlert.tsx` (`Mail` → `GmailMark`, mismo `size` y `text-ice`)
- Modify: `src/renderer/notch/claude/AlertCapsule.tsx` (`Bot` → `ClaudeMark`, conserva `text-wait`)
- Modify: `src/renderer/control-center/ControlCenterApp.tsx` (`claude: ClaudeMark`, `gmail: GmailMark`)
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: `GmailMark`, `ClaudeMark` de `src/renderer/shared/brand-icons.ts` (Task 1).

- [ ] **Step 1: Cambiar los iconos** en los cinco archivos y quitar de los imports de `lucide-react` los que dejen de usarse (`GmailStatus` no se toca).
- [ ] **Step 2: DESIGN.md**: en la regla de iconos ("Los iconos son Lucide con trazo de 1.8 px…") añadir "salvo las marcas de servicio (Gmail, GitHub, GitLab, Claude), monocromas, que heredan el color de su sitio; fuente y licencia en `THIRD_PARTY_NOTICES.md`". Actualizar las menciones: bloque Gmail de la cápsula (`Mail` → marca de Gmail), bloque de revisiones y aviso de revisión (`Github` → Invertocat), panel Gmail (casilla con la marca de Gmail), aviso de correo nuevo, Control Center → Gmail, aviso de pregunta de Claude (`Bot` → destello de Claude, sigue en Ámbar).
- [ ] **Step 3: Verificar**

Run: `npm run typecheck && npm run lint && npm test`
Expected: todo en verde.

### Task 3: Verificación completa y revisión visual

- [ ] **Step 1:** `npm run test:e2e` → todas las pruebas pasan.
- [ ] **Step 2:** Capturas con Playwright `_electron` (solo ventanas de la app; nunca el escritorio): fila de baldosas en ES, cápsula compacta con correo y revisiones, aviso de correo y menú de Control Center. Comprobar que la fila no supera 404/414 px y que las marcas se leen a 12–16 px. Capturas en el scratchpad, no en el repo.
- [ ] **Step 3:** Dejar todo sin commitear y presentar el resumen al usuario para que apruebe el commit.
