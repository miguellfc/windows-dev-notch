# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

App de escritorio solo para Windows 11: la UI es web (React) renderizada dentro de ventanas Electron. No es un sitio web, ni móvil, ni multiplataforma.

## Stack

Elegido por el usuario: Electron, React, TypeScript, Vite (electron-vite), Tailwind CSS, Motion, Zustand, Vitest, Playwright (`_electron`), empaquetado con electron-builder (NSIS). Añadidos aprobados: zod, lucide-react, koffi. SQLite entra en la Fase 2, no en el MVP.

## Users

Usuario principal: el autor, desarrollador en Windows 11 que lleva 3 o más proyectos en paralelo, cada uno con su sesión de Claude Code en la app de escritorio Claude, a menudo con varios monitores. Quizá lo comparta más adelante con algún compañero de trabajo del mismo perfil.

Job to be done: "Cuando trabajo en varios proyectos con varias sesiones de Claude a la vez, quiero ver de un vistazo qué necesita mi atención y actuar al momento, para no perder tiempo cambiando de app ni olvidar cosas."

No es para: usuarios de macOS/Linux, quien busque un launcher universal o sustituir la búsqueda de Windows, quien quiera una isla decorativa o de multimedia, equipos con gestión centralizada. Usuarios de Claude Code por CLI/IDE: probablemente funciona (mismos hooks), pero no es prioritario.

## Product Purpose

Developer Notch (nombre provisional) es una cápsula flotante y discreta arriba al centro de la pantalla, inspirada en Dynamic Island. Muestra solo lo que necesita atención ahora (estado de las sesiones de Claude Code, recordatorios pendientes, eventos sin ver) y permite actuar con una o dos pulsaciones sin salir de la app actual.

Dolor que elimina, en palabras del usuario: tiempo perdido yendo a "una aplicación X" para algo que podría resolverse desde un notch; sesiones de Claude esperando permiso sin que nadie se entere; cosas olvidadas porque nada le avisa.

Éxito (tras 2 semanas de uso diario): ya no revisa a mano la app Claude para ver si una sesión espera; abre sus proyectos/URLs habituales desde la cápsula y no desde el Menú Inicio o la barra de tareas; la app sigue abierta todo el día sin cerrarla por molesta.

## Positioning

Estado en vivo de agentes de IA más acción rápida, en un único punto siempre disponible que nunca roba el foco ni tapa contenido, hecho para desarrolladores en Windows. En macOS ya hay varias apps de notch que supervisan sesiones de Claude Code; en Windows las islas existentes (Notchify, Isle Notch, DynamicWin, Smart Notch) se centran en multimedia, portapapeles y toasts, y los launchers (PowerToys Command Palette, Flow Launcher) cubren la búsqueda universal. Developer Notch no compite en búsqueda universal: su launcher son favoritos curados junto al estado de los agentes.

## Operating Context

- Se usa todo el día junto a un IDE (WebStorm), navegador, terminales, la app de escritorio Claude y videollamadas; a menudo con ventanas maximizadas y en varios monitores con distinto escalado DPI.
- Interacción teclado primero: un atajo global (por defecto `Ctrl+Alt+Space`, configurable) abre el panel con el buscador enfocado; el click también expande; el hover solo da feedback; Esc o click fuera cierran.
- La cápsula nunca debe estorbar: se reduce a una píldora mínima sobre ventanas maximizadas y se oculta en apps a pantalla completa y modo presentación; se oculta sin cerrarse y vive en el system tray.
- Tres superficies: la cápsula (compact / peek / alert / expanded / mini / hidden), el panel expandido y el Control Center (una ventana normal aparte para la configuración).
- El estado de Claude Code llega mediante hooks documentados de Claude Code que hacen POST a un bridge en localhost; la app instala esos hooks en `~/.claude/settings.json` solo con confirmación del usuario, mostrando un diff y haciendo backup.

## Capabilities and Constraints

MVP (en orden de construcción):
- M0: spike técnico (ventana transparente adaptable, clicks a través, detección de pantalla completa/maximizado, hooks desde la app de escritorio Claude, foco y DPI mixto).
- M1 Foundation: cápsula con todos los estados y animación de morph, multi-monitor (sigue al cursor) y DPI, tray, atajo global, inicio con Windows, esqueleto del Control Center, instalador NSIS.
- M2 Quick Launcher: solo favoritos curados a mano (app, carpeta, proyecto, URL, comando de lista blanca con argumentos fijos), búsqueda por teclado.
- M3 Estado de Claude Code: sesiones trabajando / esperando / terminada / error / inactiva, alerta en la cápsula más toast nativo si está oculta, click lleva la app Claude al frente.
- M4 Recordatorios: recordatorios locales rápidos (relativos, a una hora, repetición diaria) con alerta en la cápsula más toast, posponer/completar, recordatorios perdidos mostrados al arrancar.

Fases posteriores: centro de notificaciones con historial, Developer Toolbox, Meetings (Google Calendar/Gmail), más proveedores de agentes, aprobar permisos de Claude desde la cápsula ("could" post-MVP), System Monitor, automatizaciones, n8n.

Restricciones:
- UI bilingüe desde el inicio: español e inglés, seleccionable por el usuario. Todo texto pasa por i18n; los layouts deben tolerar la más larga de las dos cadenas.
- Sin ejecución arbitraria de comandos: la UI solo envía IDs de favoritos; el proceso main ejecuta lo que el usuario guardó.
- Sin secretos en el renderer ni credenciales en texto plano; futuros tokens OAuth con `safeStorage` de Electron.
- Sin APIs no documentadas de Claude Code; los transcripts no se leen como API. No existe forma documentada de abrir una sesión concreta de la app de escritorio por ID: "ir a la sesión" significa traer la app Claude al frente.
- Debe seguir funcionando con proveedores externos desconectados; cada módulo muestra "no conectado" en lugar de fallar.
- Coste en reposo casi nulo (CPU ≈ 0 %, RAM total < 200 MB).
- Fuera de alcance: multiplataforma, launcher universal, terminal o chat con Claude embebidos, widgets de multimedia/portapapeles, sync en la nube, cuentas, firma de código y auto-update (por ahora).

Sin decidir: enfocar la sesión exacta de Claude en lugar de la app; detección de compartir pantalla (solo el modo presentación es detectable); si aprobar permisos de Claude desde la cápsula compensa su coste de seguridad.

## Brand Commitments

- Nombre: "Developer Notch" es provisional. El diseño no debe depender de él (sin logotipo tipográfico ni identidad basada en el nombre por ahora).
- Voz: concisa, técnica, tranquila. Primero el estado; sin tono de marketing ni exclamaciones. Español e inglés transmiten lo mismo con la misma brevedad.

## Evidence on Hand

- Requisitos de producto: `.claude/PRPs/prds/developer-notch.prd.md` (problema, hipótesis, métricas, fases, criterios de aceptación).
- Maquetas de brainstorming de la dirección visual aprobada: `.superpowers/brainstorm/26473-1794201328/content/` (visual-direction.html, architecture.html); material de trabajo, no assets de producción.
- No existen todavía logo, set de iconos propio, testimonios, usuarios aparte del autor, datos de uso ni benchmarks. No inventarlos.

## Product Principles

1. **Atención, no información.** Mostrar solo lo que necesita al usuario ahora; un módulo sin nada que decir no ocupa espacio.
2. **Nunca estorbar.** La cápsula cede ante el trabajo del usuario: pequeña en reposo, mínima sobre ventanas maximizadas, invisible en pantalla completa; los clicks fuera de ella siempre llegan a la app de debajo.
3. **Actuar en dos pulsaciones.** Toda acción frecuente es accesible desde el atajo global sin ratón.
4. **Seguro por construcción.** La UI solo puede pedir lo que el usuario ya guardó o aprobó; las integraciones externas nunca rompen el resto de la app.
5. **Estado honesto.** Los estados salen de señales documentadas; cuando algo se infiere o está desconectado, se dice en lugar de adivinar.

## Accessibility & Inclusion

Sin necesidades específicas del producto más allá del estándar: contraste WCAG AA, operación completa por teclado con foco visible, respeto a `prefers-reduced-motion` y render correcto con escalado de Windows al 100/125/150 %.

## Cambio de dirección (2026-11-09)

El notch es un punto de **integraciones vivas**: iconos que despliegan una mini versión de una herramienta dentro del propio notch, sin configurar listas de aplicaciones. La primera integración es una **terminal real de PowerShell** embebida. Esto sustituye al Quick Launcher de favoritos (aparcado en `feat/m2-quick-launcher`) y a dos líneas anteriores de este documento:
- "Fuera de alcance: terminal embebida" → ahora dentro de alcance.
- "Sin ejecución arbitraria de comandos" → **solo se ejecuta lo que el usuario escribe en la terminal**; la terminal vive aislada, la crea solo el proceso main y ningún otro canal puede escribir en ella.
