# Registro de cambios

Todos los cambios relevantes de Developer Notch se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

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
