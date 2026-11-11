# Notas rápidas (integración del notch) — Diseño

**Fecha:** 2026-11-11 · **Rama:** `feat/notes` (desde `dev`)
**Fuentes:** PRD ("Cambio de dirección: integraciones vivas"), `DESIGN.md`, patrón de M4 (recordatorios: store JSON, servicio serializado, vista 420×320).

## Objetivo

Apuntar algo al vuelo (un comando, un ID, una idea) desde el notch sin cambiar de app, y recuperarlo, copiarlo o buscarlo después.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Forma | **Lista de notas** cortas, cada una con su texto y fecha |
| Funciones | **Copiar** al portapapeles, **editar**, **fijar arriba**, **buscar**; borrar con **Deshacer** |
| Dónde | **Solo en el notch** (sin página en Control Center) |
| Guardado | `userData/notes.json` con el patrón de los recordatorios (escritura atómica, cuarentena si se corrompe). Descartados un Markdown suelto (frágil para editar/fijar) y SQLite (módulo nativo innecesario) |

## Modelo

```ts
Note = {
  id: string            // uuid, lo genera main
  text: string          // 1–2000 caracteres tras recortar; multilínea; al menos un carácter visible
  pinned: boolean
  createdAt: string     // ISO
  updatedAt: string     // ISO
}
NotesFile = { version: 1, notes: Note[] }
```

- Máximo **500** notas; crear la 501 devuelve un error claro.
- Orden de la lista: fijadas primero, después por `updatedAt` descendente (ambos grupos).
- Fijar o desfijar no cambia `updatedAt`.

## Arquitectura

### Main (`src/main/notes/`)

- **`notes-store.ts`**: `load()`, `all()`, `write(list)` con `fs-atomic`, validación zod, cuarentena (`notes.corrupt-<fecha>.json`) y solo lectura si la versión es más nueva; escrituras serializadas.
- **`notes-service.ts`**: `list()`, `create(text)`, `update(id, text)`, `setPinned(id, pinned)`, `remove(id)`, `restore(note)` (para Deshacer), todo serializado como el servicio de recordatorios; ids inexistentes → `NOT_FOUND`; texto inválido → `INVALID_INPUT`.
- **Copiar**: `notes:copy { id }` → main escribe el texto de esa nota con `clipboard.writeText`. El renderer nunca envía texto al portapapeles.
- **Integración Electron** (`notes-integration.ts`): crea store y servicio, carga sin bloquear el registro de IPC (puerta `ready` como recordatorios) y emite `notes:changed` al notch.

### IPC

| Canal | Entrada | Salida | Quién |
|---|---|---|---|
| `notes:list` | — | `{ notes: Note[]; notice: 'quarantined' \| 'read-only' \| null }` | **solo notch** |
| `notes:create` | `{ text }` | `Note` | solo notch |
| `notes:update` | `{ id, text }` | `Note` | solo notch |
| `notes:pin` | `{ id, pinned }` | `Note` | solo notch |
| `notes:delete` | `{ id }` | `Note` (la borrada, para Deshacer) | solo notch |
| `notes:restore` | `{ id }` (de una nota borrada) | `Note` | solo notch |
| `notes:copy` | `{ id }` | `null` | solo notch |
| evento `notes:changed` | — | mismo payload que `list` | main → notch |

`notes:restore` solo restaura una nota que main borró en los últimos **10 s** (main guarda las borradas recientes en memoria, por `id`) y cuyo `id` no exista ya; fuera de eso → `NOT_FOUND`. El renderer nunca reenvía el contenido de la nota.

### Notch

- Integración `notes` en `src/shared/integrations/registry.ts` (icono Lucide `StickyNote`), vista y modo `notes` con panel de **420×320** (`CAPSULE_SIZES.notes`).
- **Cabecera**: `←` (volver a la fila), `+` (nueva nota) y un **buscador**; el filtro es inmediato y no distingue mayúsculas ni acentos (normalización NFD sin diacríticos).
- **Nueva / editar**: el panel muestra un `textarea` (foco al abrir) con contador `n / 2000`; **Ctrl+Enter** guarda, **Esc** cancela y vuelve a la lista; aviso si el texto está vacío o es demasiado largo.
- **Lista**: cada fila muestra la chincheta si está fijada, las **2 primeras líneas** del texto (resto recortado) y hace cuánto se editó ("hace 3 min"); acciones visibles con hover o foco: **Copiar** (muestra "Copiado" 1,5 s), **Editar**, **Fijar/Desfijar**, **Borrar**. Objetivos ≥ 24 px.
- **Borrar**: inmediato; aparece una barra "Nota borrada · Deshacer" durante **5 s**; Deshacer llama a `notes:restore`.
- **Vacío**: "Sin notas todavía. Pulsa + para crear una." / búsqueda sin resultados: "Ninguna nota coincide".
- Teclado: Esc en la lista vuelve a la fila de integraciones (como Recordatorios); en el buscador con texto, el primer Esc lo vacía.
- i18n ES/EN; tokens de `DESIGN.md`; el texto de las notas se pinta siempre como texto, en Geist (`white-space: pre-wrap` en el editor; recortado a 2 líneas en la lista).

## Seguridad y privacidad

1. Las notas pueden contener datos sensibles: se guardan solo en este equipo y **nunca** se escriben en el log (solo ids y recuentos).
2. Todos los canales `notes:*` solo desde el webContents del notch; entradas validadas con zod.
3. El portapapeles lo escribe main a partir de un `id`.

## Pruebas

- **Unitarias**: esquema (límites, texto invisible), store (cuarentena, solo lectura, serialización), servicio (orden fijadas/fecha, límite 500, fijar sin tocar `updatedAt`, `NOT_FOUND`, restore dentro y fuera de los 10 s, restore de un id existente rechazado), normalización de búsqueda (acentos/mayúsculas), guards IPC.
- **E2E**: crear dos notas, buscar una por texto sin acentos, editarla, fijarla (pasa arriba), copiarla (leer el portapapeles desde main en el test), borrar y deshacer; capturas ES/EN de la lista y del editor.

## Criterios de aceptación

1. Crear una nota desde el notch en < 5 s (icono → + → escribir → Ctrl+Enter).
2. Buscar filtra al instante ignorando mayúsculas y acentos.
3. Copiar deja el texto exacto en el portapapeles.
4. Las fijadas siempre aparecen arriba.
5. Borrar se puede deshacer durante 5 s.
6. Las notas sobreviven a reiniciar la app.

## Fuera de alcance

Página en Control Center, Markdown/formato, etiquetas o carpetas, sincronización, adjuntos, cifrado del archivo.
