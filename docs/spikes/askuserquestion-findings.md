# Spike: responder `AskUserQuestion` desde un hook — Hallazgos

**Fecha:** 2026-11-12 · **Superficie probada:** app de escritorio de Claude (pestaña Code), sesión en marcha.
**Pregunta:** ¿puede un hook `http` de `PreToolUse` responder las preguntas de opción múltiple de Claude (`AskUserQuestion`) para que el notch las conteste en lugar de la ventana de Claude?

## Montaje

- Copia de `~/.claude/settings.json` (SHA-256 `7deeb0bd…d989`) antes de tocarlo; al terminar se restauró **idéntico byte a byte** (mismo hash).
- Se añadió un tercer grupo a `hooks.PreToolUse`, sin tocar los existentes: `{ "matcher": "AskUserQuestion", "hooks": [{ "type": "http", "url": "http://127.0.0.1:47911/hook", "timeout": 600 }] }`.
- Servidor de prueba desechable (Node, solo `127.0.0.1`) que esperaba **8 s** y respondía `permissionDecision: "allow"` con `updatedInput = { ...tool_input, answers }`. Solo registró nombres de campos, recuentos y tiempos; nunca el texto de preguntas u opciones.
- Prueba: una llamada a `AskUserQuestion` con 3 preguntas (opción única, `multiSelect`, y una tercera contestada con texto libre).

## Resultados

| Comprobación | Resultado |
|---|---|
| Evento que llega | `PreToolUse` con `tool_name: "AskUserQuestion"` (el grupo con `matcher` lo filtra) |
| Campos del evento | `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id` |
| `tool_input` | `{ questions: [{ question, header, options: [{ label, description }], multiSelect }] }` |
| Espera del hook | Claude **esperó 8 014 ms** a la respuesta (por encima de los 2 s de los demás grupos); el límite es el `timeout` del grupo |
| Respuesta de opción única | `answers[pregunta] = "<label>"` → Claude recibió esa opción |
| Respuesta `multiSelect` | etiquetas unidas por `", "` (`"Manzana, Pera"`) → recibido tal cual |
| Texto libre ("Otro") | una cadena que no es ninguna etiqueta → **aceptada** y entregada tal cual |
| Ventana de Claude | la respuesta llegó sin que el usuario tuviera que elegir en el diálogo de Claude |

## Conclusiones para el diseño

1. **Viable en la app de escritorio**: el notch puede contestar `AskUserQuestion` respondiendo al hook `PreToolUse` con `allow` + `updatedInput.answers` (y las `questions` originales).
2. Hace falta un **grupo de hook propio** con `matcher: "AskUserQuestion"` y un `timeout` largo (como el de `PermissionRequest`, 3600 s), porque el grupo general de `PreToolUse` del notch tiene 2 s.
3. El texto libre funciona, así que el notch puede ofrecer "Otro" con un campo de texto.
4. Si el notch no responde (o responde `{}`/error), Claude sigue con su diálogo normal: el usuario nunca se queda sin poder contestar.
5. Pendiente de comprobar en la implementación: qué pasa si el usuario contesta en la ventana de Claude mientras el hook espera (el hook debe soltar la espera, p. ej. con `PostToolUse`/`Stop` de esa sesión, como hace el broker de permisos), y el comportamiento en la CLI y en VS Code (no probado).
