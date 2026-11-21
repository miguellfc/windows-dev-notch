# Registro de cambios

Todos los cambios relevantes de Developer Notch se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [0.3.0] - 2026-11-21

Rediseño visual completo y integraciones configurables. La cápsula, el panel, las vistas, las alertas y Control Center adoptan un lenguaje nuevo, más compacto y casi monocromo, en el que cada integración tiene su propio color.

### Añadido

- Página «Integraciones» en Control Center: activar o desactivar cada integración, elegir si aparece en la cápsula y cambiar su color con un selector libre (matiz, saturación, luminosidad, código hexadecimal y atajos).
- Cápsula compacta en tres zonas fijas: hora y fecha | integraciones | sistema. Muestra la marca de Claude mientras alguna sesión tiene actividad (también en el peek), el correo sin leer, las contribuciones del mes en GitHub y GitLab y las horas imputadas este mes en Redmine.
- Panel principal con accesos rápidos verticales, las métricas del sistema en la cabecera y una fila de tarjetas de integraciones que se recorre con la rueda.
- GitHub y GitLab: gráfico de contribuciones del mes con el resumen de hoy, la semana y el mes, y acceso directo al perfil.
- Redmine: resumen de horas con el gráfico del mes, buscador por asunto, proyecto o número y detalle de la tarea a vista completa, con su estado, su estimación, las horas que ya tiene imputadas e «Imputar horas».
- Redmine acepta las horas en sus propios formatos: «1,5», «1h 25m», «1:25» o «25m».

### Cambiado

- Nueva tipografía: Nunito para el texto, la hora y las métricas del sistema; Geist Mono para los datos y Jersey 10 para las cifras grandes.
- La cápsula, el peek y las vistas de GitHub, GitLab y Redmine se ajustan a su contenido, sin espacios vacíos.
- Métricas del sistema con iconos nuevos. El almacenamiento muestra el porcentaje usado de todo el equipo y sigue avisando si algún disco se queda sin espacio.
- El indicador de conexión refleja si hay salida a internet real según Windows, no solo si hay una red conectada.
- Las contribuciones de GitHub y GitLab se consultan cada 15 minutos aunque la vista esté cerrada, para mostrarlas en la cápsula.

### Eliminado

- La vista y la tarjeta de Sistema: sus datos están ahora en la cabecera del panel y en la cápsula.
- Las listas de PR/MR («Por revisar» y «Míos») de GitHub y GitLab. La alerta de primera revisión de tus PR/MR se mantiene.
- La lista de tareas asignadas de Redmine en reposo: se llega a ellas desde el buscador.

### Notas

- Los ajustes se migran solos al formato nuevo (versión 9) al abrir la 0.3.0.
- El indicador de conexión necesita Windows 10 versión 2004 o posterior.

## [0.2.0] - 2026-11-17

Developer Notch se ha rehecho sobre Tauri 2 para que pese y consuma menos. No hay funciones nuevas: todo lo de la 0.1.0 funciona igual, con la misma interfaz y los mismos textos en español e inglés.

### Cambiado

- La app pasa de Electron a Tauri 2: el proceso principal está escrito en Rust y la interfaz se ejecuta en WebView2, el motor web que trae Windows 11.
- Instalador mucho más pequeño: unos 3,3 MB frente a 117 MB, y unos 11,3 MB en disco frente a 344 MB, más el WebView2 del sistema.
- Menos memoria: unos 198 MB de memoria privada en reposo frente a 301 MB, contando todos los procesos de la app y con todas las integraciones conectadas (Claude Code, GitHub, GitLab, Redmine y Gmail). En reposo usa menos del 1 % de un núcleo.
- Los tokens y claves (Gmail, GitHub, GitLab y Redmine) se siguen cifrando con el cifrado de Windows, ahora mediante DPAPI.
- El instalador se ofrece en español e inglés, se instala solo para el usuario actual y no necesita permisos de administrador (salvo para quitar una 0.1.0 instalada para todos los usuarios).
- Al actualizar desde la 0.1.0, el instalador la detecta, avisa y la desinstala antes de instalar, y quita su entrada de inicio con Windows. Si cancelas el aviso, la instalación se detiene.

### Eliminado

- Electron y todo lo que dependía de él.

### Notas

- **Los datos de la 0.1.0 no se migran.** Se conservan en `%APPDATA%\Developer Notch`, pero la 0.2.0 guarda los suyos en `%APPDATA%\dev.developernotch.app` y empieza de cero: ajustes por defecto, sin notas ni recordatorios.
- **Hay que volver a configurar las integraciones** (Gmail, GitHub, GitLab y Redmine) desde el Control Center, y volver a activar el inicio con Windows si lo usabas.
- **Hay que reinstalar los hooks de Claude Code** desde el Control Center. Los de la 0.1.0 siguen en `~/.claude/settings.json` apuntando a una versión que ya no está; la instalación los sustituye, mostrando el diff antes de confirmar y con copia de seguridad, como siempre.
- Requiere WebView2 Evergreen. Viene con Windows 11; si faltara, el instalador lo descarga.
- Los avisos de terceros (`THIRD_PARTY_NOTICES.md`) incluyen ahora las licencias de los crates de Rust, de los paquetes npm de la interfaz y de las fuentes Geist.

### Diferencias conocidas

- **Fecha de hoy alrededor de medianoche.** En algunas zonas horarias, las reglas de horario de Windows y las de la interfaz no coinciden del todo. Cuando pasa, durante como mucho una hora al día la app y la interfaz pueden no estar de acuerdo en qué día es hoy: afecta a las horas de hoy de Redmine, a la fecha que se propone al imputar, al aviso de fin de jornada y al día de hoy en las contribuciones de GitHub y GitLab. Se corregirá después de la 0.2.0.
- **Fechas de algunos correos.** Si la cabecera de fecha de un correo no sigue el formato estándar (por ejemplo, sin zona horaria o solo con el día), se muestra la fecha en que Gmail lo recibió en lugar de interpretar la cabecera.
- **Correos con HTML mal formado.** En unos pocos casos de HTML incorrecto (etiquetas de cierre con un espacio tras `</`, bloques `CDATA`, comentarios cerrados con `--!>`, `<!>`, `</>` o caracteres nulos), el texto del mensaje puede salir algo distinto que en la 0.1.0. Los correos bien formados se leen igual.
- **Conexión directa, sin proxy.** GitHub, GitLab, Gmail y Redmine se consultan con conexión directa: no se usa el proxy del sistema (una VPN sí funciona). Además, Gmail ya no sigue redirecciones (GitHub, GitLab y Redmine tampoco las seguían en la 0.1.0): si una red con portal cautivo intercepta la conexión, Gmail se muestra sin conexión en lugar de cerrar la sesión.
- **Respuestas muy grandes.** Una respuesta de más de 16 MB de GitHub, GitLab, Gmail o Redmine se rechaza como respuesta no válida.
- **Barra de título del Control Center.** Usa la barra de título nativa de Windows, en oscuro sobre Mica, en lugar de la integrada de la 0.1.0.

## [0.1.0] - 2026-11-14

Primera versión.

### Añadido

- Cápsula flotante arriba al centro de la pantalla, sin robar el foco, con sus modos: peek en reposo (hora y fecha), compacta al pasar el puntero (métricas, correo y revisiones), alerta, panel expandido, mini fijada por el usuario en el borde superior (clic derecho) y oculta. Sigue al cursor entre monitores y respeta el escalado DPI.
- Panel expandido con baldosas por integración, botones de icono en la cabecera (Control Center y Ocultar) y atajo global configurable para abrirlo (por defecto `Ctrl+Alt+Space`).
- Icono en la bandeja del sistema, inicio con Windows opcional e interfaz en español e inglés.
- Monitor del sistema: CPU, RAM, discos y procesos en el panel, con métricas en la cápsula.
- Alertas del sistema por umbral (CPU y RAM sostenidas, batería y el peor disco fijo) que pintan en rojo las métricas de la cápsula.
- Recordatorios locales (relativos, a una hora o con repetición diaria) con alerta en la cápsula y notificación nativa, posponer y completar, y aviso de los perdidos al arrancar.
- Notas rápidas desde el panel.
- Estado de Claude Code mediante hooks: sesiones trabajando, esperando, terminadas, con error o inactivas, con alerta en la cápsula y notificación nativa si está oculta. La app instala los hooks en `~/.claude/settings.json` solo tras confirmar, mostrando el diff y haciendo copia de seguridad.
- Aprobar o denegar permisos de Claude Code, y responder a sus preguntas (`AskUserQuestion`), desde el notch.
- Baldosas que abren Claude Desktop y Windows Terminal.
- Gmail con la API oficial y un cliente OAuth propio: contador de no leídos de Principal, lista de los más recientes, lectura como texto, marcar como leído, borrar con confirmación y aviso de correo nuevo. Guía en `docs/gmail-setup.md`.
- GitHub y GitLab (instancia propia) con tokens de solo lectura: PR/MR pendientes de tu revisión y propios abiertos, aviso de primera revisión (aprobado, cambios pedidos o revisado) y vista de contribuciones. Guía en `docs/code-review-setup.md`.
- Redmine con clave API: horas imputadas hoy en la cápsula, resumen mensual, tareas asignadas abiertas, cambio de estado, ajuste de estimación, imputar horas y aviso de fin de jornada. Guía en `docs/redmine-setup.md`.
- Control Center, ventana aparte para la configuración general, atajo, sistema, Claude, recordatorios, Gmail, GitHub/GitLab y Redmine.
- Iconos de marca monocromos para Gmail, GitHub, GitLab, Claude y Redmine.
- Registro local de uso.
- Instalador NSIS para Windows (`npm run dist`).

### Notas

- Solo Windows 11. No hay soporte para macOS ni Linux.
- Los ajustes y los datos se guardan localmente en este equipo. Los tokens y claves (Gmail, GitHub, GitLab, Redmine) se cifran con `safeStorage` de Windows.
- Redmine solo admite URLs `https`.
- Aún no se declara una licencia; los avisos de terceros están en `THIRD_PARTY_NOTICES.md`.
