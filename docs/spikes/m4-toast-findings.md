# M4 spike: acciones en el toast de Windows

Fecha: 2026-11-10. Electron 45.2.3, Windows 11 (build 26300). Código en `spikes/m4/toast-actions/` (desechable, fuera del lint: el script `lint` ya usa `--ignore-pattern "spikes/**"`).

## Veredicto: **B**

Toast sin botones; el clic en el cuerpo abre la vista de recordatorios. Pendiente de verificación manual: los botones se ven (variante `toastXml`), pero no se pudo comprobar de forma automática que el clic en un botón llegue a la app con un botón identificable. Si el usuario lo confirma a mano, se puede subir a A.

## Qué dicen los tipos (`node_modules/electron/electron.d.ts`)

- `NotificationConstructorOptions.actions?: NotificationAction[]`: "Actions to add to the notification. Please read the available actions and limitations in the `NotificationAction` documentation." Sin `@platform`: cualquier plataforma.
- `NotificationAction.type`: `'button' | 'selection'` ("`selection` is only supported on Windows"); `text` es la etiqueta.
- `NotificationConstructorOptions.toastXml?: string`: "A custom description of the Notification on Windows superseding all properties above. Provides full customization of design and behavior of the notification." `@platform win32`.
- Evento `action`: `(details: Event<NotificationActionEventParams>, actionIndex: number /* deprecated */, selectionIndex: number /* deprecated, win32 */)`; `NotificationActionEventParams = { actionIndex, selectionIndex }` ("The index of the action that was activated"). Sin restricción de plataforma en los tipos.
- Evento `click`: "Emitted when the notification is clicked by the user."
- `ActivationArguments` (app activada en frío): `type: 'click' | 'action' | 'reply'`, `actionIndex`, `arguments`.

## Qué se ejecutó

`main.js` (Electron, `app.setAppUserModelId('com.spike.toastactions')`) registra en `events.log` todos los eventos (`show`, `click`, `action`, `close`, `failed`, `reply`):

- Variante 1: `new Notification({ title, body, actions: [Posponer, Completar] })`.
- Variante 2: `toastXml` con `<actions><action content="Posponer" arguments="snooze" activationType="foreground"/><action content="Completar" arguments="done" activationType="foreground"/></actions>`.

Capturas con `shot.ps1` (CopyFromScreen); Win+N y clics con `seq.ps1`/`click.ps1`.

## Qué se vio

- **El equipo tiene "No molestar" activado** ("Do not disturb is on / You'll only see banners for priority notifications"). Por eso no aparece ningún banner emergente: ambas variantes emiten `show` y a los ~15 ms `close {"reason":"timedOut"}` y el toast va directo al Centro de notificaciones (agrupado bajo "Electron", porque la app no está empaquetada). No se tocó el ajuste del sistema. Captura sin banner: `spikes/m4/toast-actions/v1-at-show.png`.
- **Variante 2 (`toastXml`): los botones "Posponer" y "Completar" se ven** al expandir el toast en el Centro de notificaciones: `spikes/m4/toast-actions/ac4b.png`.
- Variante 1 (`actions` nativo): se emite `show` sin `failed`, pero no se llegó a ver renderizada en el Centro de notificaciones (no se expandió). Sin dato visual.
- La UI del Centro de notificaciones no es accesible por UI Automation (ni por nombre "Posponer" ni por árbol), así que la prueba de clic fue con ratón simulado por coordenadas.

## Eventos recibidos

- `show` en ambas variantes; nunca `failed`.
- `V2 click []` a las 20:01:37Z, mientras se expandía el toast con un clic en la cabecera del grupo (no con un clic en un botón). Es el único `click` visto y no se puede atribuir con certeza al cuerpo; el clic en cuerpo no queda verificado.
- **Ningún evento `action`**: no se consiguió pulsar "Posponer" (el segundo intento de clic cerró el Centro de notificaciones y descartó los toasts: `close userCanceled`).
- Se detuvo la prueba por clics a ciegas sobre el escritorio del usuario (riesgo de efectos colaterales).

## Para el plan

- Plan B (toast silencioso, clic abre la vista de recordatorios): depende de `click`. Falta confirmar que `click` llega con la app en marcha; el único indicio es el `V2 click` anterior.
- Para subir a A, comprobar a mano con "No molestar" desactivado: lanzar `VARIANT=1` y `VARIANT=2` (`node_modules/.bin/electron spikes/m4/toast-actions`), pulsar cada botón y mirar `events.log` buscando `action` (con `actionIndex`) en la variante 1 y cómo llega el argumento `snooze`/`done` en la variante 2 (con `toastXml` y `activationType="foreground"` no hay evento `action` documentado; habría que leerlo del evento `click` o de `ActivationArguments`).
