---
name: gitflow
description: Use when releasing a new version of Developer Notch, preparing a release or hotfix branch, tagging a version, merging dev into main, or when the user asks how to publish, "sacar una versión", "hacer el release", "hotfix" or follow gitflow in this repository.
---

# Gitflow en Developer Notch

## Ramas del proyecto

| Gitflow clásico | Aquí | Para qué |
|---|---|---|
| `master` | `main` | Solo versiones publicadas. Cada merge a `main` lleva su tag. |
| `develop` | `dev` | Integración. Las ramas `feat/*`, `fix/*`, `chore/*` y `docs/*` salen de `dev` y vuelven a `dev` por PR. |
| `release/*` | `release/X.Y.Z` | Preparar una versión. Sale de `dev`. |
| `hotfix/*` | `hotfix/X.Y.Z` | Arreglo urgente de lo publicado. Sale de `main`. |

**Tags:** el número de versión sin `v` (`0.1.0`, `0.2.0`), anotado y puesto sobre el merge commit de `main`.

**Dónde está la versión:**
- `package.json`. `src-tauri/tauri.conf.json` la lee de ahí con `"version": "../package.json"`.
- `src-tauri/Cargo.toml` (`[package] version`).
- `src-tauri/Cargo.lock` y `package-lock.json` se actualizan con ella.
- `CHANGELOG.md` sigue Keep a Changelog: `## [X.Y.Z] - AAAA-MM-DD`.

## Quién hace qué

- El agente prepara ramas y cambios, y propone los commits. **Nunca hace commit sin aprobación, ni push, ni abre o fusiona PR, ni crea tags remotos.** Todo eso lo hace el usuario.
- Los PR se fusionan con **merge commit** («Create a merge commit»), nunca con squash ni rebase. Equivale al `--no-ff` de gitflow: el historial conserva que la versión entró como un bloque.

## Release (nueva versión X.Y.Z)

1. **Partir de `dev` al día.**
   ```bash
   git fetch origin --prune
   git switch dev
   git pull --ff-only origin dev
   git switch -c release/X.Y.Z
   ```
2. **En `release/X.Y.Z` solo se prepara la versión:**
   - Subir la versión en `package.json` y en `src-tauri/Cargo.toml`.
   - Sincronizar los locks: `npm install --package-lock-only` y, dentro de `src-tauri`, `cargo update -p developer-notch --offline`.
   - Añadir la entrada `## [X.Y.Z] - AAAA-MM-DD` en `CHANGELOG.md`.
   - Corregir los fallos que salgan al probar. **Nada de funciones nuevas:** eso va a `dev` en una `feat/*` y entra en la siguiente versión.
3. **Comprobar** con los gates del proyecto:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run test:rust`
   - `npm run build`, que debe generar `Developer Notch_X.Y.Z_x64-setup.exe`.
4. **Commit** `chore: preparar la versión X.Y.Z`, con aprobación. El push de la rama lo hace el usuario.
5. **PR `release/X.Y.Z` → `main`**, fusionado con merge commit.
6. **Tag en `main`**, sobre ese merge commit:
   ```bash
   git switch main
   git pull --ff-only origin main
   git tag -a X.Y.Z -m "Developer Notch X.Y.Z"
   git push origin X.Y.Z
   ```
7. **Instalador y release en GitHub:**
   - Con `main` en el tag, ejecutar `npm ci` y `npm run build`.
   - En GitHub, abrir Releases → Draft a new release y elegir el tag `X.Y.Z`.
   - Título: `Developer Notch X.Y.Z`. Texto: la sección del `CHANGELOG`. Adjuntar el instalador.
8. **Devolver `main` a `dev`:** PR `main` → `dev` con merge commit. Así `dev` recibe el merge commit y cualquier arreglo hecho en la rama de release. Sin este paso, `main` y `dev` divergen y el siguiente release arrastra conflictos.
9. **Borrar la rama de release**, en local y en remoto:
   ```bash
   git branch -d release/X.Y.Z
   git push origin --delete release/X.Y.Z
   ```

## Hotfix (arreglo urgente de la versión publicada)

1. Crear la rama desde `main` al día:
   ```bash
   git switch main
   git pull --ff-only origin main
   git switch -c hotfix/X.Y.(Z+1)
   ```
2. Hacer el arreglo con su prueba, subir la versión de parche y añadir la entrada al `CHANGELOG`.
3. PR `hotfix/…` → `main` con merge commit. Después, tag `X.Y.(Z+1)` en `main` e instalador, igual que en los pasos 6 y 7 del release.
4. Devolver el arreglo a la rama de integración:
   - Lo normal es un PR `main` → `dev`.
   - **Si en ese momento hay una `release/*` abierta, el arreglo va a esa rama de release** en lugar de a `dev`. Llegará a `dev` cuando esa release termine.
5. Borrar `hotfix/…`.

## Errores comunes

| Error | Qué pasa | Lo correcto |
|---|---|---|
| PR `dev` → `main` directo | Entra en la versión todo lo que haya en `dev`, también lo que no se probó para ella | Pasar por `release/X.Y.Z` |
| Fusionar con squash o rebase | Se pierde el merge commit, el tag no corresponde a un bloque y el back-merge da conflictos | Merge commit siempre |
| Tag antes del merge, o en otra rama | El tag no apunta a lo publicado | Tag en `main` después de fusionar el PR |
| Tag `v0.2.0` | Rompe la convención del repositorio | `0.2.0`, como `0.1.0` |
| Olvidar `main` → `dev` | `dev` no tiene el merge commit ni los arreglos de la release | Paso 8 siempre |
| Instalador generado desde `dev` o una rama de trabajo | Lo publicado no coincide con el tag | Generarlo desde el tag en `main` |
| `git stash -u` para cambiar de rama | Guarda miles de archivos de compilación (`src-tauri/target`, `src-tauri/gen`, `spikes/*`) | Son salidas ignoradas en `dev`: cambiar con `git switch` y, si Git se queja de un archivo concreto, resolver solo ese |
| Hacer commit, push o crear el PR sin pedirlo | Rompe las reglas del usuario | Proponer y esperar aprobación |

## Si la versión ya se preparó en `dev`

Pasó con la 0.2.0: la parte 7 subió la versión y fechó el `CHANGELOG` directamente en `dev`. En ese caso:
- Se crea igualmente `release/X.Y.Z` desde `dev` al día.
- En ella se comprueba que la versión, la fecha, los gates y el instalador están bien.
- Se sigue desde el paso 4. Si no hay nada que cambiar, el paso 4 no lleva commit.

En la siguiente versión, la subida de versión vuelve a hacerse en la rama de release.
