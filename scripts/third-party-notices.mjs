// Generates THIRD_PARTY_NOTICES.md: the Rust crates in the app's Windows runtime graph, the npm
// packages bundled into the renderer and the bridge, the Geist fonts and the brand icons.
// Run with `npm run notices`. It reads only local data: `cargo metadata --offline` (crate license
// files come from the Cargo registry) and `node_modules`. The output is sorted, so it is stable.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'THIRD_PARTY_NOTICES.md')
const TARGET = 'x86_64-pc-windows-msvc'

// devDependencies whose own code still ends up in the shipped bundle: the bridge imports
// @tauri-apps/api, the renderer CSS is built from tailwindcss (`@import 'tailwindcss'`), and Vite
// injects its modulepreload polyfill. Their own dependencies are build tools and are not walked.
const BUNDLED_DEV_DEPENDENCIES = ['@tauri-apps/api', 'tailwindcss', 'vite']
const FONT_PACKAGES = ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', '@fontsource/jersey-10']

// License alternatives covered by the standard texts at the end of the crate section.
const STANDARD_IDS = new Set(['MIT', 'Apache-2.0'])

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|copyrightnotice)([-._ ].*)?$/i

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function normalizeText(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

function licenseFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name) && !/\.spdx$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(byText)
    .map((name) => ({ name, text: normalizeText(readFileSync(join(dir, name), 'utf8')) }))
}

function copyrightLines(texts) {
  const lines = new Set()
  for (const text of texts) {
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (/^(copyright\b|©)/i.test(line) && /\d{4}|\(c\)|©/i.test(line) && !/\[yyyy\]|\{yyyy\}|<year>/i.test(line)) {
        lines.add(line)
      }
    }
  }
  return [...lines]
}

/** The OR alternatives of an SPDX expression, or null when it has an AND (all terms apply). */
function alternatives(expression) {
  const flat = expression.replace(/\//g, ' OR ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/\sAND\s/.test(flat)) return null
  return flat.split(' OR ').map((term) => term.trim())
}

function coveredByStandardTexts(expression) {
  const terms = alternatives(expression)
  return terms !== null && terms.some((term) => STANDARD_IDS.has(term) || term.startsWith('Apache-2.0 WITH '))
}

function isApacheText(text) {
  return /^\s*Apache License\s*\n\s*Version 2\.0/.test(text)
}

/** A crate's own files, minus the Apache text (shipped once) and NOTICE files (listed apart). */
function ownFiles(crate) {
  return crate.files.filter((file) => !isApacheText(file.text) && !/^notice/i.test(file.name))
}

function fence(text) {
  return '````text\n' + text + '\n````'
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|')
}

function repoUrl(value) {
  if (!value) return ''
  const url = typeof value === 'string' ? value : value.url ?? ''
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/')
}

function groupByText(entries) {
  const groups = new Map()
  for (const { owner, text } of entries) {
    if (!groups.has(text)) groups.set(text, new Set())
    groups.get(text).add(owner)
  }
  return [...groups]
    .map(([text, owners]) => ({ text, owners: [...owners].sort(byText) }))
    .sort((a, b) => byText(a.owners[0], b.owners[0]))
}

/** One heading per distinct text, naming every package it applies to. */
function pushGroups(out, level, groups) {
  for (const group of groups) {
    const [first, ...rest] = group.owners
    out.push(`${level} ${first}${rest.length > 0 ? ` y ${rest.length} más` : ''}`)
    out.push('')
    if (rest.length > 0) {
      out.push(`Se aplica a: ${group.owners.join(', ')}.`)
      out.push('')
    }
    out.push(fence(group.text))
    out.push('')
  }
}

// ---------------------------------------------------------------------------------------------
// Rust crates

function crateNotices() {
  const json = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--filter-platform', TARGET, '--offline'],
    { cwd: join(ROOT, 'src-tauri'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const metadata = JSON.parse(json)
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const root = metadata.resolve.root

  // Normal (runtime) edges only: build and dev dependencies never ship.
  const seen = new Set([root])
  const queue = [root]
  while (queue.length > 0) {
    const node = nodes.get(queue.shift())
    for (const dep of node.deps) {
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue
      // A proc-macro runs inside the compiler and never ships; neither do its own dependencies.
      if (packages.get(dep.pkg).targets.some((target) => target.kind.includes('proc-macro'))) continue
      if (seen.has(dep.pkg)) continue
      seen.add(dep.pkg)
      queue.push(dep.pkg)
    }
  }
  seen.delete(root)

  const crates = [...seen]
    .map((id) => packages.get(id))
    .map((pkg) => {
      const dir = dirname(pkg.manifest_path)
      const files = licenseFiles(dir)
      if (pkg.license_file) {
        const path = join(dir, pkg.license_file)
        if (existsSync(path) && !files.some((file) => join(dir, file.name) === path)) {
          files.push({ name: pkg.license_file, text: normalizeText(readFileSync(path, 'utf8')) })
        }
      }
      return {
        key: `${pkg.name} ${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? (pkg.license_file ? `ver ${pkg.license_file}` : 'sin declarar'),
        repository: repoUrl(pkg.repository ?? pkg.homepage),
        authors: pkg.authors ?? [],
        files,
      }
    })
    .sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version))

  const own = crates.filter((crate) => !coveredByStandardTexts(crate.license))
  const standard = crates.filter((crate) => coveredByStandardTexts(crate.license))

  // Texts a crate's own license demands, from its own files (the Apache text is shipped once).
  const ownEntries = []
  const missing = []
  for (const crate of own) {
    const files = ownFiles(crate)
    if (files.length === 0) missing.push(crate)
    for (const file of files) ownEntries.push({ owner: `${crate.key} (${crate.license})`, text: file.text })
  }

  // A crate without its own file takes the text of a single-license crate with the same license.
  const textById = new Map()
  for (const crate of own) {
    const files = ownFiles(crate)
    if (alternatives(crate.license)?.length === 1 && files.length === 1 && !textById.has(crate.license)) {
      textById.set(crate.license, files[0].text)
    }
  }
  const unresolved = []
  for (const crate of missing) {
    const text = textById.get(crate.license)
    if (text) ownEntries.push({ owner: `${crate.key} (${crate.license}; el paquete no trae el texto)`, text })
    else unresolved.push(crate)
  }

  const noticeEntries = crates.flatMap((crate) =>
    crate.files.filter((file) => /^notice/i.test(file.name)).map((file) => ({ owner: crate.key, text: file.text })),
  )

  const apacheSource = crates
    .flatMap((crate) => crate.files.map((file) => ({ crate, file })))
    .find(({ file }) => isApacheText(file.text) && file.text.includes('END OF TERMS AND CONDITIONS'))
  if (!apacheSource) throw new Error('No crate ships the Apache-2.0 text')
  const apacheText = apacheSource.file.text.slice(
    0,
    apacheSource.file.text.indexOf('END OF TERMS AND CONDITIONS') + 'END OF TERMS AND CONDITIONS'.length,
  )

  const out = []
  out.push('## Crates de Rust')
  out.push('')
  out.push(
    `El ejecutable incluye ${crates.length} crates: las dependencias de ejecución de \`developer-notch\` para \`${TARGET}\` ` +
      '(sin las de compilación, las de pruebas ni las macros procedimentales, que solo se usan al compilar), según `cargo metadata`.',
  )
  out.push('')
  out.push('| Crate | Versión | Licencia | Repositorio |')
  out.push('|---|---|---|---|')
  for (const crate of crates) {
    out.push(`| ${cell(crate.name)} | ${crate.version} | ${cell(crate.license)} | ${crate.repository || '—'} |`)
  }
  out.push('')

  out.push('### Textos de licencia propios')
  out.push('')
  out.push(
    'Los crates cuya licencia no se cumple con los textos estándar de MIT o Apache 2.0 (MPL-2.0, Unicode-3.0, BSD, Zlib y otras), ' +
      'con el texto que trae cada paquete. Los crates con el mismo texto se agrupan.',
  )
  out.push('')
  const mpl = own.filter((crate) => alternatives(crate.license)?.includes('MPL-2.0'))
  if (mpl.length > 0) {
    out.push(
      'El código fuente de los crates con licencia MPL-2.0 (' +
        mpl.map((crate) => `${crate.key}: ${crate.repository || 'crates.io'}`).join('; ') +
        ') está disponible en su repositorio y en crates.io (`https://crates.io/crates/<nombre>/<versión>`), sin cambios.',
    )
    out.push('')
  }
  pushGroups(out, '####', groupByText(ownEntries))
  for (const crate of unresolved) {
    out.push(`#### ${crate.key} (${crate.license})`)
    out.push('')
    out.push('El paquete no incluye el texto de su licencia. Véase su repositorio.')
    out.push('')
  }

  if (noticeEntries.length > 0) {
    out.push('### Archivos NOTICE')
    out.push('')
    pushGroups(out, '####', groupByText(noticeEntries))
  }

  out.push('### Avisos de copyright de los crates con licencia MIT o Apache 2.0')
  out.push('')
  out.push(
    'Estos crates se distribuyen bajo MIT o Apache 2.0 (cuando el crate ofrece las dos, se puede elegir cualquiera). ' +
      'Los avisos salen de sus archivos de licencia; si no traen ninguno, se indican los autores de su `Cargo.toml`.',
  )
  out.push('')
  for (const crate of standard) {
    const lines = copyrightLines(crate.files.filter((file) => !isApacheText(file.text)).map((file) => file.text))
    const notice =
      lines.length > 0
        ? lines.join('; ')
        : crate.authors.length > 0
          ? `Autores: ${crate.authors.join(', ')}`
          : 'Sin aviso de copyright en el paquete'
    out.push(`- ${crate.key} (${crate.license}): ${notice}`)
  }
  out.push('')
  out.push('#### Texto de la licencia MIT')
  out.push('')
  out.push(fence(MIT_TEXT))
  out.push('')
  out.push('#### Texto de la licencia Apache 2.0')
  out.push('')
  out.push(fence(apacheText))
  out.push('')

  const licenses = new Map()
  for (const crate of crates) licenses.set(crate.license, (licenses.get(crate.license) ?? 0) + 1)
  return {
    text: out.join('\n'),
    stats: {
      crates: crates.length,
      ownTexts: groupByText(ownEntries).length,
      ownCrates: own.length,
      unresolved: unresolved.map((crate) => crate.key),
      notices: noticeEntries.length,
      licenses: [...licenses].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// npm packages

function packageDir(name, from) {
  // Node's resolution: the nearest node_modules up from the requiring package, then the root.
  let dir = from
  while (dir.startsWith(ROOT)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === ROOT) break
    dir = dirname(dir)
  }
  throw new Error(`Package not installed: ${name} (run npm install)`)
}

/** Drops the licenses of a tool's own bundled dependencies (Vite's LICENSE.md lists them; they do not ship here). */
function ownLicensePart(text) {
  const cut = text.search(/^#+ Licenses of bundled dependencies/m)
  return cut === -1 ? text : text.slice(0, cut).replace(/\n+$/, '')
}

function npmNotices() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const roots = [...Object.keys(manifest.dependencies ?? {}), ...BUNDLED_DEV_DEPENDENCIES]
  const found = new Map()
  const queue = roots.map((name) => ({ name, from: ROOT, walk: !BUNDLED_DEV_DEPENDENCIES.includes(name) }))
  while (queue.length > 0) {
    const { name, from, walk } = queue.shift()
    const dir = packageDir(name, from)
    if (found.has(dir)) continue
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'sin declarar'
    found.set(dir, {
      key: `${pkg.name} ${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      license,
      repository: repoUrl(pkg.repository ?? pkg.homepage),
      files: licenseFiles(dir).map((file) => ({ ...file, text: ownLicensePart(file.text) })),
    })
    if (!walk) continue
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, walk: true })
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      try {
        packageDir(dep, dir)
        queue.push({ name: dep, from: dir, walk: true })
      } catch {
        // An optional dependency that is not installed does not ship.
      }
    }
  }
  const packages = [...found.values()].sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version))
  const fonts = packages.filter((pkg) => FONT_PACKAGES.includes(pkg.name))
  const others = packages.filter((pkg) => !FONT_PACKAGES.includes(pkg.name))
  for (const name of FONT_PACKAGES) {
    if (!fonts.some((pkg) => pkg.name === name)) throw new Error(`Font package missing from dependencies: ${name}`)
  }

  const out = []
  out.push('## Fuentes Geist')
  out.push('')
  out.push(
    'La interfaz incluye las fuentes Geist y Geist Mono (de Vercel), empaquetadas por Fontsource, bajo la SIL Open Font License 1.1. ' +
      'Su licencia exige distribuir este texto con las fuentes.',
  )
  out.push('')
  for (const font of fonts) {
    out.push(`- ${font.key} (${font.license}): ${font.repository || '—'}`)
  }
  out.push('')
  pushGroups(out, '###', groupByText(fonts.flatMap((font) => font.files.map((file) => ({ owner: font.key, text: file.text })))))

  out.push('## Paquetes npm de la interfaz')
  out.push('')
  out.push(
    'Las dependencias de producción de `package.json` y las suyas, que van empaquetadas en la interfaz, más ' +
      BUNDLED_DEV_DEPENDENCIES.map((name) => `\`${name}\``).join(', ') +
      ', que figuran entre las de desarrollo pero cuyo propio código va en la interfaz (el puente, los estilos y el polyfill de modulepreload).',
  )
  out.push('')
  out.push('| Paquete | Versión | Licencia | Repositorio |')
  out.push('|---|---|---|---|')
  for (const pkg of others) {
    out.push(`| ${cell(pkg.name)} | ${pkg.version} | ${cell(pkg.license)} | ${pkg.repository || '—'} |`)
  }
  out.push('')
  out.push('### Textos de licencia')
  out.push('')
  const entries = others.flatMap((pkg) => pkg.files.map((file) => ({ owner: pkg.key, text: file.text })))
  pushGroups(out, '####', groupByText(entries))
  const withoutText = others.filter((pkg) => pkg.files.length === 0)
  if (withoutText.length > 0) {
    out.push(`Sin archivo de licencia en el paquete: ${withoutText.map((pkg) => pkg.key).join(', ')}.`)
    out.push('')
  }
  return {
    text: out.join('\n'),
    stats: { packages: others.length, fonts: fonts.length, withoutText: withoutText.map((pkg) => pkg.key) },
  }
}

// ---------------------------------------------------------------------------------------------

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const ICONS = `## Iconos

### Simple Icons 13.21.0

- Origen: https://github.com/simple-icons/simple-icons
- Licencia: CC0 1.0 Universal (dominio público)
- Iconos usados: \`gmail\`, \`github\`, \`claude\`, \`redmine\` (en \`src/renderer/shared/brand-icons.ts\`)

### Lucide (iconos y marca de GitLab)

- Origen: https://github.com/lucide-icons/lucide (versiones anteriores a lucide-react 1.x)
- Licencia: ISC
- Uso: \`GitlabMark\` en \`src/renderer/shared/brand-icons.ts\`, la marca de GitLab que distribuía Lucide antes de retirar sus iconos de marcas. El resto de iconos de la interfaz salen de \`lucide-react\`, con su licencia en la sección de paquetes npm.

Texto completo de la licencia de Lucide, copiado de \`node_modules/lucide-react/LICENSE\`:

${'````'}text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

${MIT_TEXT}
${'````'}`

const TRADEMARKS = `## Marcas

Gmail, GitHub, GitLab, Claude y Redmine son marcas de sus respectivos dueños; se usan solo para identificar el servicio.`

const crates = crateNotices()
const npm = npmNotices()

const document = [
  '# Avisos de terceros',
  '',
  'Developer Notch incluye software, fuentes e iconos de terceros. Este archivo se genera con `npm run notices` ' +
    '(`scripts/third-party-notices.mjs`) a partir de `cargo metadata` y `node_modules`; no se edita a mano.',
  '',
  '- [Iconos](#iconos)',
  '- [Fuentes Geist](#fuentes-geist)',
  '- [Paquetes npm de la interfaz](#paquetes-npm-de-la-interfaz)',
  '- [Crates de Rust](#crates-de-rust)',
  '- [Marcas](#marcas)',
  '',
  ICONS,
  '',
  npm.text,
  crates.text,
  TRADEMARKS,
  '',
].join('\n')

writeFileSync(OUTPUT, document)

const summary = {
  crates: crates.stats.crates,
  cratesWithOwnText: crates.stats.ownCrates,
  ownTextGroups: crates.stats.ownTexts,
  noticeFiles: crates.stats.notices,
  unresolvedCrates: crates.stats.unresolved,
  crateLicenses: Object.fromEntries(crates.stats.licenses),
  npmPackages: npm.stats.packages,
  fontPackages: npm.stats.fonts,
  npmWithoutText: npm.stats.withoutText,
}
console.log(`Wrote ${OUTPUT}`)
console.log(JSON.stringify(summary, null, 2))
