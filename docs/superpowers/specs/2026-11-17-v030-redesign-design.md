# Developer Notch 0.3.0 — Rediseño visual e integraciones configurables

Estado: **aprobado por el usuario el 2026-11-17**.
Fecha: 2026-11-17 · Rama base: `dev` · Rama de trabajo prevista: `feat/v030-redesign` (o varias `feat/v030-*`, ver «Entregas»).

## Intención

La 0.2.0 cerró la migración a Tauri sin tocar la interfaz. La 0.3.0 renueva el aspecto: pasa de «Obsidian» (negro neutro con un único acento azul hielo) a una estética de herramienta de desarrollador compacta. Toma dos referencias del usuario:

- **Referencia 1:** panel negro con tarjetas gris oscuro de esquinas grandes, etiquetas en mayúsculas espaciadas, cifras grandes en blanco y la selección en blanco.
- **Referencia 2** (la preferida): tarjetas con un borde sutil, verde de terminal, coral, detalles pixel y mono, y teclas en cajitas.

Durante el diseño el usuario amplió el alcance: además del cambio visual, la 0.3.0 reorganiza la cápsula compacta y el panel principal, deja activar y colorear cada integración desde Control Center y simplifica las vistas de GitHub, GitLab y Redmine. Ya no es una versión «solo estilos». Este documento cubre ambas cosas.

Las maquetas aprobadas viven en la conversación de diseño. Este documento las describe con el detalle suficiente para construir sin ellas.

## Objetivos

1. Un lenguaje visual nuevo («fusión»), coherente en la cápsula, el panel, las vistas, las alertas y Control Center.
2. Integraciones activables, cada una con su color, que el usuario elige en Control Center.
3. Una cápsula compacta con distribución fija: hora y fecha | integraciones | sistema.
4. Un panel principal con accesos rápidos verticales y una fila de tarjetas de integraciones que se recorre con la rueda.
5. Vistas de GitHub, GitLab y Redmine reducidas a lo esencial.

## No objetivos

- No hay integraciones nuevas, ni tema claro, ni personalización de la cápsula más allá de la columna «Cápsula».
- No cambian los modos de la cápsula (peek, compacta, mini, alerta, expandida, oculta), sus transiciones, el atajo, la bandeja ni la lógica de prioridad de las alertas.
- No cambia la lógica de datos de Gmail, Notas, Recordatorios, Sistema ni Claude, solo su aspecto. La excepción son las vistas de GitHub, GitLab y Redmine, que pierden secciones.
- No hay alerta nueva de «Claude terminó»: no existe hoy y no se añade.

## Anti-objetivos (fracaso aunque funcione)

- **Que la interfaz parezca un arcoíris.** Cuando no pasa nada, la cápsula y el panel deben leerse casi monocromos. El color de cada integración vive en su icono, su tarjeta y su vista, no en superficies grandes.
- **Que el color deje de significar algo.** El coral siempre es «te necesito» y el rojo siempre es «fallo o aviso del sistema». Ninguna integración puede elegir como color propio uno que se confunda con ellos (ver la paleta).
- **Que la cápsula estorbe más que hoy:** más ancha que la ventana, texto que salte de línea o anchos que parpadeen.
- **Que se pierda accesibilidad:** foco visible, contraste AA, teclado completo o `prefers-reduced-motion`.

## Enfoques considerados

1. **Imagen 2 pura.** Verde y coral como acentos globales, fuente pixel en todas las cifras, tarjetas con borde. Es la que tiene más carácter, pero el verde global choca con el verde de «terminado» y la pantalla se ve muy colorida.
2. **Imagen 1 pura.** Monocroma, blanco para la selección, cifras grandes en sans gruesa y dock con círculo blanco. Es elegante, pero pierde la personalidad de herramienta de desarrollador que el usuario prefería.
3. **Fusión (elegida).** La base es la imagen 1 (monocromía, tarjetas suaves, blanco = selección). El carácter viene de la imagen 2: fuente pixel para la hora y las cifras grandes, verde y coral con un significado cada uno, y teclas en cajitas. Encima, el usuario añadió el color por integración. Se eligió porque cada color tiene un único trabajo y la interfaz se mantiene tranquila hasta que algo pide atención.

## Lenguaje visual

### Superficies y forma

| Token (propuesto) | Valor | Uso |
|---|---|---|
| `--color-void` | `#050506` | Cápsula (todas sus formas) y panel. Sustituye a Obsidiana y Obsidiana Densa. La cápsula conserva su translucidez del 86 % (`rgba(5,5,6,.86)`) y el panel sigue opaco (The Denser When Busier Rule). |
| `--color-card` | `#131315` | Tarjetas dentro del panel y de las vistas. |
| `--color-card-hover` | `#1A1A1D` | Fila o tarjeta con hover o foco. |
| `--color-field` | `#0B0B0D` | Campos, buscadores y selects. |
| `--color-control` | `#1F1F23` | Botones secundarios. |
| `--color-line` | `rgba(255,255,255,.05)` | Filo de las tarjetas y divisores de fila. |
| `--color-line-strong` | `rgba(255,255,255,.08)` | Borde de campos y de teclas. |
| `--color-chalk` | `#F2F2F4` | Texto principal **y color de selección**: botón principal, opción elegida, página activa, interruptor encendido, casilla activa. |
| `--color-graphite` | `#8E8E96` | Texto secundario, etiquetas y datos. Hay que comprobar el contraste: sobre `--color-void` debe ser ≥ 4,5:1, y si sobre la cápsula translúcida encima de una ventana blanca no llega, se mantiene la variante Grafito Cristal (`#A3A3AB`). |

Radios: panel 26 px, tarjeta 18 px, campos y botones en pastilla (radio = mitad del alto), opciones dentro de una tarjeta 12 px, teclas 6 px. Se mantiene The Nested Radius Rule.

Sombras: la Levitación se mantiene. Las tarjetas no llevan sombra y la profundidad viene del tono y del filo.

### Color con significado

| Color | Valor | Significa | Ejemplos |
|---|---|---|---|
| Blanco (Tiza) | `#F2F2F4` | Estás aquí / acción principal | «Guardar», «Imputar», «Enviar», «Permitir»; opción elegida; página activa; interruptor encendido; sesión trabajando (punto). Verde para trabajando y terminada haría indistinguibles los dos estados donde el punto solo lleva color. |
| Coral | `#FF8A7A` | Te necesita | Permiso y pregunta de Claude, sesión esperando, recordatorio vencido, «Cambios pedidos». Sustituye al Ámbar Espera. |
| Verde | `#4ADE80` | Hecho / OK (estado) | Sesión terminada, «Checks ✓», confirmación de guardado cuando la vista no tiene integración con color |
| Rojo | `#F87171` | Fallo / aviso del sistema | Métrica en umbral, error, «Borrar» de la confirmación, campo inválido |
| Color de la integración | elegido | Pertenece a esta integración | Ver la sección siguiente |

El anillo de foco pasa de azul hielo a **Tiza** (2 px, desplazamiento de 2 px). El caret y la selección de texto también pasan a Tiza sobre Void, con el texto seleccionado en `--color-void`.

### Color por integración

- Paleta cerrada de 21 colores (el usuario pidió más valores dos veces), con nombres para i18n y ordenada por tono (tres filas de 7 en el selector):

  | Nombre | Hex |
  |---|---|
  | Pistacho | `#D9F99D` |
  | Lima | `#A3E635` |
  | Verde | `#4ADE80` |
  | Esmeralda | `#10B981` |
  | Turquesa | `#2DD4BF` |
  | Cian | `#22D3EE` |
  | Celeste | `#38BDF8` |
  | Azul | `#7DD3FC` |
  | Cobalto | `#60A5FA` |
  | Índigo | `#818CF8` |
  | Violeta | `#A78BFA` |
  | Lavanda | `#C4B5FD` |
  | Ciruela | `#C084FC` |
  | Fucsia | `#E879F9` |
  | Rosa | `#F472B6` |
  | Salmón | `#FDA4AF` |
  | Melocotón | `#FDBA74` |
  | Naranja | `#FB923C` |
  | Ámbar | `#FBBF24` |
  | Arcilla | `#CC785C` |
  | Arena | `#D6C7A1` |

  Salmón y Arcilla se ajustaron respecto a los valores iniciales (`#F28B82` y `#D97757`): con la comprobación de distancia OKLab quedaban a 0,024 del coral `#FF8A7A` y a 0,067 del rojo `#F87171`, y el criterio es ≥ 0,07 frente a ambos. Con `#FDA4AF` y `#CC785C` se cumple, y todos los colores siguen dando ≥ 5:1 sobre la tarjeta.

  Algunos pares son cercanos a propósito (Azul y Celeste, Violeta y Lavanda), para dar matices. Si la comprobación de contraste o de distinción muestra dos indistinguibles a 12 px, se ajusta el tono, sin quitar entradas.

  No hay blanco ni gris en la paleta, porque el blanco (Tiza) es la selección. Todos deben dar ≥ 3:1 sobre `--color-card` como color de icono y de gráfico; se comprueba en el plan. El coral `#FF8A7A` y el rojo `#F87171` **no** están en la paleta, porque tienen significado propio. Hay que comprobar con el bloque de contraste que Salmón y Naranja se distinguen lo bastante del coral; si no, se ajustan. Esta comprobación es parte del plan.
- Colores por defecto: Claude = Arcilla, GitHub = Verde, GitLab = Naranja, Gmail = Salmón, Redmine = Rosa, Recordatorios = Azul, Notas = Violeta, Sistema = Turquesa.
- Dónde se usa el color:
  - el icono de la integración en la cápsula compacta, en su tarjeta, en la cabecera de su vista, en sus alertas y en el toast;
  - un velo de arriba abajo en su tarjeta del panel (el color al 8–9 % arriba, que se funde con `--color-card` a mitad de la tarjeta);
  - las visualizaciones de su vista: rejilla de contribuciones o de horas (niveles al 25 / 45 / 70 / 100 %), anillos y barras de progreso;
  - los puntos de «no leído», la chincheta de las notas y las confirmaciones de éxito de su vista («1,5 h imputadas»).
- Dónde no se usa nunca: fondos de panel o de vista, texto de cuerpo, botones principales (siguen en blanco) y el anillo de foco.
- Un estado (coral, rojo) gana siempre al color de la integración en el mismo elemento.

### Tipografía

- **Geist** para todo el texto. Las cifras grandes de las tarjetas, si no van en pixel, usan Geist 700.
- **Geist Mono** para los datos: tiempos, rutas, refs, horas pequeñas, porcentajes de la cápsula y teclas.
- **Jersey 10** (pixel estrecha, licencia OFL) **solo** para la hora (en la cápsula y en la cabecera del panel) y para las cifras grandes de métricas: Hoy, Semana y Mes de GitHub, GitLab y Redmine; el próximo recordatorio; el total de la tarjeta de GitHub; las horas de la tarjeta de Redmine. Se empaqueta en la app (por ejemplo, `@fontsource/jersey-10` si existe y su versión es de hace más de dos semanas; si no, el archivo de Google Fonts con su licencia en `THIRD_PARTY_NOTICES.md`). Nunca se carga desde la red.
- La escala corta (11 / 12,5 / 13 / 15 px) sigue rigiendo el texto. Se añade una escala de cifras: 20 px (hora del panel), 22–26 px (métricas en las vistas) y 13 px (hora de la cápsula, con su tamaño óptico ajustado para que ocupe lo mismo que hoy, o se mide de nuevo). El tamaño final de Jersey 10 se ajusta por medición, porque es estrecha y necesita unos 1,3× el cuerpo de Geist para igualar el alto de las cifras.
- Las etiquetas de grupo siguen en mayúsculas a 10,5 px, con el tracking ligeramente más abierto (0.11em).

### Teclas en cajitas

Componente `Kbd` con el nuevo estilo: Geist Mono 10,5 px, fondo `#17171A`, borde `--color-line-strong` y radio de 6 px. Solo aparece donde hay un atajo que no es obvio:
- en la línea de ayuda del panel principal: `Esc cerrar · ←→ casillas · Enter abrir`, en Grafito y centrada al pie del panel;
- en el permiso y en la pregunta de Claude (`Esc cerrar`, `Ctrl+Enter enviar`);
- en el editor de notas (`Ctrl+Enter guardar`).

Así vuelve una línea de pie de 20 px al panel principal (se quitó el 2026-11-14). El usuario la aprobó en las maquetas.

## Superficies

### Cápsula peek y mini

- **Peek:** la hora en Jersey 10 y la fecha en Geist 12,5 en Grafito Cristal, sobre Void al 86 %. El tamaño (168×36) se recalcula si la fuente nueva cambia el ancho.
- **Mini:** sin cambios (96×4, Void, Levitación Baja).

### Cápsula compacta (cambia)

Distribución fija en tres zonas, separadas por un divisor vertical de 1 px y 14 px de alto (`--color-line-strong`):

1. **Izquierda:** hora (Jersey 10) y fecha (Geist, Grafito Cristal). Siempre.
2. **Centro:** los bloques de las integraciones que tengan activada la columna «Cápsula» en Control Center, en el orden del registro. Cada bloque lleva el icono de 12 px en el color de la integración y la cifra en Geist Mono (Tiza):
   - **Claude:** los puntos de estado de las sesiones (y «+N»), como hoy. Hoy esos puntos **sustituyen** a la fecha (`dateOrDots` en `NotchApp.tsx`). En la 0.3.0 la fecha se queda siempre a la izquierda y los puntos pasan a ser un bloque propio del centro, con su ancho medido y añadido a `compactWidthFor`;
   - **Gmail:** no leídos («99+»);
   - **GitHub / GitLab:** PR/MR propios sin revisar;
   - **Redmine:** horas de hoy («5,5h»);
   - Recordatorios, Notas y Sistema no tienen bloque de cápsula. La columna «Cápsula» no se ofrece para ellas.
   - Se mantienen los latches de hoy (`CAPSULE_MISSES`, la desaparición inmediata sin sesión, etc.). Si no hay ningún bloque visible, la zona central y su divisor desaparecen.
3. **Derecha:** el sistema, siempre presente, en Geist Mono con Grafito Cristal: CPU %, RAM %, almacenamiento (% usado de C: o de la peor unidad fija; ver «Decisiones del constructor»), conexión y batería %. Se oculta la batería si no hay. Cuando hay aviso de sistema, la cifra se pinta en rojo, como hoy. El bloque de disco en aviso se integra en el de almacenamiento: deja de ser un bloque aparte y la cifra pasa a rojo.
   - **Conexión:** icono `Wifi`, `EthernetPort` o `WifiOff` según el tipo de enlace, sin cifra. Si main no puede dar el tipo, se usa un único icono de conexión que solo distingue con y sin red. Requiere datos que hoy solo trae la muestra completa (`network` en `fullSampleSchema`) o que no existen (el estado en línea). Ver «Restricciones».

**Geometría.** `COMPACT_WIDTHS` y el cálculo de `compactWidthFor` se rehacen para la nueva composición. El ancho de la ventana (hoy 760 px = cápsula más ancha + 2×56) se recalcula con el peor caso nuevo: todas las integraciones de cápsula activas, «99+» en cada una, las horas «23,75h», todas las métricas y batería. Si el peor caso más el panel nuevo (ver abajo) supera los 760 px, la ventana crece. Esto es intencionado y las pruebas de geometría se actualizan a propósito. Nunca se anima `width`: el cambio de ancho sigue usando el fundido cruzado.

### Panel principal (cambia)

Ancho previsto: unos 660 px (el ancho exacto se fija midiendo, para que se vean 3,5 tarjetas y se entienda que hay más). Alto: cabecera de 28 + tarjetas de 196 + indicador y ayuda + padding, unos 300 px. Medir y fijar en `EXPANDED_HEIGHTS`, que pasa a tener un solo valor porque las sesiones viven en una tarjeta de alto fijo.

- **Cabecera:** hora (Jersey 10, 20 px), divisor, fecha (Grafito) y, a la derecha, `Cog` (Control Center) y `EyeOff` (Ocultar), como hoy. **Sin métricas de sistema.**
- **Columna de accesos rápidos** (izquierda, vertical): botones de 44×44, radio 14, fondo `--color-card` y filo. Por ahora:
  1. **Claude:** el icono en su color. Lleva un punto coral de 10 px arriba a la derecha si alguna sesión espera permiso o respuesta. Abre Claude Desktop como hoy.
  2. **Terminal:** abre Windows Terminal como hoy.

  Son accesos de lanzamiento, no integraciones: no tienen tarjeta ni vista. Si Claude está desactivado en Control Center, su botón desaparece. Terminal siempre está.
- **Fila de tarjetas** (a la derecha de la columna): una tarjeta de 172×196, radio 18, por cada integración activa con vista, en el orden del registro. La rueda vertical del ratón desplaza la fila en horizontal, con `scroll-snap` por tarjeta. La última tarjeta visible se funde por la derecha con una máscara para insinuar que hay más. Debajo, un indicador de posición: la página activa es una barra de 16 px en Tiza y las demás, puntos de 4 px. Clic o Enter en una tarjeta abre su vista, igual que hoy la casilla. Las flechas ←/→ mueven el foco entre tarjetas y la llevan a la vista. Contenido de cada tarjeta, que es un resumen y no añade datos nuevos:
  - **Claude Code:** las dos sesiones más relevantes (las que esperan primero), con punto de estado, proyecto y «espera permiso · 2 min» o «trabajando · 14 min». Clic: si hay una sesión esperando, abre su permiso o pregunta; si no, lleva Claude al frente como hoy. Sin sesiones: «Sin sesiones activas». ¿Tarjeta o no? Ver «Decisiones del constructor».
  - **GitHub / GitLab:** una minirejilla del mes (celdas de 9 px) en su color y el total del mes en Jersey 10 con «contribuciones · nov».
  - **Gmail:** el número de no leídos en su color junto al título y los 3 correos más recientes (remitente en negrita si no está leído, asunto en una línea).
  - **Redmine:** las horas de hoy en Jersey 10, «de N h hoy» (N = el objetivo diario configurado, `redmine.target`) y una barra de progreso en su color.
  - **Recordatorios:** el próximo recordatorio (hora en Jersey 10 y texto) y, si hay alguno vencido, una línea coral.
  - **Notas:** las 3 notas fijadas o más recientes, una línea cada una.
  - **Sistema:** tres anillos pequeños (CPU, RAM, C:) en su color, que pasan a rojo en aviso.
  - Estados (sin configurar, sin conexión, cargando) en pequeño y centrados, con el mismo texto que en su vista.
- **Línea de ayuda** con teclas (ver «Teclas en cajitas»).

### Vistas

Todas comparten la cabecera de 30 px: `←`, el icono en el color de la integración, el título (Geist 600, 15 px) y, a la derecha, Actualizar si existe. El contenido va en tarjetas `--color-card`, las listas dentro de tarjetas con divisores `--color-line` y el hover de fila en `--color-card-hover` con radio 12. Los tamaños de ventana de cada vista se mantienen salvo donde se indica.

- **Sistema:** tres tarjetas (CPU, RAM, batería), cada una con un anillo de 52 px en el color de Sistema y la cifra en Geist 700. Las sparklines de 60 s se mantienen debajo de la cifra, en el color de la integración, para no perder información. Debajo, la línea de discos y la lista de procesos en tarjeta, con el botón «Cerrar» en pastilla. Aviso: el anillo y la cifra en rojo.
- **Gmail** (lista y lectura): los puntos de no leído en el color de Gmail; la confirmación de borrado en línea con «Borrar» en rojo; los botones del pie en pastilla. Sin cambios de comportamiento.
- **Notas** (lista y editor): la chincheta en el color de Notas; «Copiado» en el color de Notas; el editor en tarjeta con `Ctrl+Enter guardar` y «Guardar» en blanco; la barra de deshacer en tarjeta.
- **Recordatorios** (lista y formulario): una tarjeta «Próximo» con la hora en Jersey 10; el vencido en coral; el formulario con campos en pastilla, el Segmented en pastilla (la opción activa en blanco) y «Guardar» en blanco.
- **GitHub y GitLab (cambia):** solo la tarjeta de contribuciones (la rejilla en el color de la plataforma, «hoy» con un anillo Tiza, Hoy, Semana y Mes en Jersey 10, «84 contribuciones en noviembre · hace 3 min» y las notas de datos parciales o privados como hoy). Debajo, una fila con la cuenta o el servidor en mono y el botón «Abrir GitHub» / «Abrir GitLab» (`ExternalLink`), que abre el perfil del usuario en la plataforma (para GitLab, en su servidor). **Se eliminan las secciones «Por revisar» y «Míos».** Las métricas se mantienen «como ya se hacía» (palabras del usuario): la tabla Hoy · Semana · Mes × Commits · PR/MR abiertos · PR/MR fusionados · Revisiones sigue igual en datos y fórmula, solo cambia de estilo (las cifras en Jersey 10, las cabeceras en `text-caps`). La maqueta mostraba tres cifras sueltas por simplificar, pero la fuente de verdad es la tabla actual. La tarjeta del panel muestra solo el total del mes del calendario (`monthTotal`), que ya existe. Tamaño: se reduce a lo que mida el contenido (unos 520×220) y deja de ser el panel más alto.
- **Redmine (cambia):**
  - **Reposo:** solo la tarjeta resumen (la rejilla del mes en el color de Redmine, Hoy, Semana y Mes en Jersey 10, «Jornada de 8 h») y el buscador. **Se elimina la lista «Tareas asignadas».**
  - **Búsqueda:** por #número o texto. Si el texto identifica una sola tarea (un #número exacto, o una sola coincidencia), su detalle aparece directamente bajo el buscador: una tarjeta Estado (select), una tarjeta Estimación (campo y Guardar) y una tarjeta Imputar horas (fecha, horas, actividad, comentario, «Abrir en Redmine» e «Imputar» en blanco). La confirmación va en el color de Redmine y los errores en rojo. Con varias coincidencias, se muestra una lista breve (máximo 5 filas) para elegir. Con ninguna, «Ninguna tarea coincide». Mientras se busca, el resumen se comprime en una línea («Hoy 5,5H · Semana 21H · Mes 38,5H»).
  - **Origen de los datos de búsqueda:** hoy la búsqueda filtra la lista de tareas asignadas que ya está cargada. Sin lista visible, la búsqueda sigue usando esos mismos datos, y un #número que no esté en ellos se pide a la API de Redmine (`GET /issues/{id}.json`) por el mismo canal de main. Ver «Decisiones del constructor».
  - Tamaño: el de reposo se ajusta al contenido. El de búsqueda con detalle mide lo que haga falta (≤ 560).
- **Permiso de Claude:** la cabecera lleva un punto coral, «Claude pide permiso» y el proyecto; el comando en una tarjeta mono; «Denegar» en pastilla y «Permitir» en blanco; `Esc cerrar`.
- **Pregunta de Claude:** la cabecera lleva el destello en el color de Claude, el proyecto y «1 de N»; la pregunta en tarjeta; la opción elegida con fondo `--color-control` y el radio en Tiza; «Otro…» como campo en pastilla; `Ctrl+Enter enviar · Esc cerrar`; «Enviar» en blanco.

### Alertas (320×44)

Misma cápsula, tamaño, duración y prioridades. Cambia:
- **Lo que te necesita** (permiso, pregunta, recordatorio vencido): un punto coral de 8 px con halo (sigue pulsando) + el icono de su integración en su color + el texto.
- **Lo informativo** (correo, revisión, fin de jornada): el icono en el color de su integración + el texto. El fin de jornada añade una minibarra de 36×4 con el progreso hacia el objetivo, en el color de Redmine.
- Una alerta de una integración desactivada no se emite.
- **Toast de Windows:** se mantiene. Su icono, si el bundler lo permite, es el de la app y no cambia; el color de la integración no aplica en el toast nativo. La maqueta mostraba un icono en color, pero solo es posible si el toast admite imagen por notificación. Ver «Decisiones del constructor».

### Control Center

- La ventana sigue con Mica oscuro. La navegación lateral usa pastillas y la página activa es una pastilla Tiza con texto Void. Tarjetas, campos e interruptores siguen el nuevo estilo: el interruptor encendido es Tiza con el pomo Void y el apagado, `#26262A` con el pomo Grafito.
- **Página nueva: Integraciones**, después de «Atajo». Una fila por integración (Claude Code, GitHub, GitLab, Gmail, Redmine, Recordatorios, Notas, Sistema) con:
  - **Activa** (interruptor). Al desactivar: la tarjeta, el bloque de la cápsula y las alertas desaparecen y la integración deja de consultar (Gmail, revisiones, Redmine, monitor de la vista Sistema). La configuración guardada (tokens, sesión) **no** se borra. Sistema no se puede desactivar del todo, porque sus métricas viven en la cápsula: su interruptor solo quita la tarjeta y la vista. Ver «Decisiones del constructor».
  - **Cápsula** (interruptor, solo para Claude, Gmail, GitHub, GitLab y Redmine). Sin la integración activa, queda deshabilitado.
  - **Color:** el selector 3 de las maquetas. A la izquierda, el icono de la integración en un cuadrado de 28 px teñido con su color (al 14 %); a la derecha, «Cambiar color». Al pulsarlo se despliega debajo una rejilla de 21 cuadrados de 28 px (tres filas de 7, con huecos de 6 px) (el color al 13 % con un punto de 10 px del color sólido), con el actual con borde de su color. Teclado: un único punto de Tab (patrón Radio Group, como `Segmented`), las flechas mueven y seleccionan, y Esc cierra. Cada cuadrado tiene `aria-label` con el nombre del color.
- Las páginas de cada integración (Gmail, GitHub y GitLab, Redmine…) no cambian de contenido, solo de estilo. Si la integración está desactivada, su página muestra arriba una línea «Desactivada · Activar en Integraciones».

## Datos y ajustes

- `settingsSchema` sube de versión (`SETTINGS_VERSION` 7 → 8) con:
  ```ts
  integrations: Record<'claude'|'github'|'gitlab'|'gmail'|'redmine'|'reminders'|'notes'|'system',
    { enabled: boolean; capsule: boolean; color: IntegrationColor }>
  ```
  `IntegrationColor` es un enum de los 21 nombres de la paleta, no un hex libre. La migración v7 → v8 activa todas las integraciones, pone `capsule: true` en las que hoy salen en la cápsula (Claude, Gmail, GitHub, GitLab, Redmine) y asigna los colores por defecto. Así, un usuario que actualiza ve lo mismo que antes, con el nuevo estilo.
- `src/shared/integrations/registry.ts` pasa a describir: los accesos rápidos (`terminal`, `claude`); las integraciones con tarjeta y vista (`claude` solo tarjeta, `github`, `gitlab`, `gmail`, `redmine`, `reminders`, `notes`, `system`); y cuáles admiten bloque de cápsula. GitHub y GitLab dejan de abrir una vista `reviews` compartida con plataforma y pasan a abrir su vista de contribuciones.
- Los tokens de color de la paleta viven en `global.css` (`--color-int-green`, …). Los componentes reciben el color por una variable CSS (`--int`) en el contenedor de la tarjeta o vista, nunca por hex en línea.

## Restricciones

- **Coste en reposo:** la cápsula compacta mostrará almacenamiento y conexión. Hoy la muestra ligera (`lightSampleSchema`, cada 3 s en peek y compacta) no trae discos ni red. Hay que extenderla de forma barata, sin enumerar procesos, y mantener CPU ≈ 0 % en reposo. Se mide antes y después.
- **Pruebas:** cambian a propósito las de geometría (`COMPACT_WIDTHS`, `WINDOW_WIDTH`, `EXPANDED_HEIGHTS`, tamaños de las vistas), las e2e de la fila de casillas (la prueba de que no se truncan las etiquetas pasa a medir las tarjetas), las de las vistas de revisiones y de Redmine (se quitan las secciones), las de settings (migración v8) y las de i18n. Las e2e de Tauri necesitan cerrada la Developer Notch instalada: hay que pedírselo al usuario.
- **i18n:** todo texto nuevo («Integraciones», «Activa», «Cápsula», «Cambiar color», nombres de colores, «Abrir GitHub», «de 8 h hoy», «Desactivada · Activar en Integraciones», la ayuda de teclas) va en ES y EN. Las tarjetas se dimensionan para la cadena más larga.
- **Accesibilidad:**
  - foco Tiza siempre visible;
  - las tarjetas son botones con nombre accesible («GitHub, 84 contribuciones en noviembre»);
  - la fila es una lista navegable con flechas;
  - el desplazamiento con la rueda no roba el foco;
  - `prefers-reduced-motion` desactiva el desplazamiento suave;
  - ningún estado depende solo del color: el coral siempre va con texto o con el punto pulsante.
- **No se edita** `eslint.config.mjs` ni los hooks del repo. No se hace commit ni push sin aprobación.
- **DESIGN.md y PRODUCT.md** se actualizan al final (North Star nuevo, tokens, reglas y superficies), sustituyendo «Obsidian». Sus reglas con nombre se reescriben: One Voice → «un color, un trabajo»; Meaningful Color se mantiene; Short Scale suma la escala de cifras.

## Entregas (propuesta)

La 0.3.0 es grande. Se divide en PR hacia `dev`, cada uno con sus pruebas en verde y su propio plan en `docs/superpowers/plans/` (entrega 1: `2026-11-17-v030-1-style-base.md`; los demás planes se escriben cuando la entrega anterior está fusionada):

1. **Tokens y estilo base:** paleta nueva, Jersey 10 empaquetada, componentes base (tarjeta, pastillas, `Kbd`, `Switch`, `Segmented`, foco) y aplicación del estilo a todas las vistas sin cambiar la estructura.
2. **Integraciones configurables:** settings v8 con migración, la página Integraciones con el selector de color, el color por integración en vistas y alertas, y el apagado de integraciones.
3. **Cápsula compacta nueva:** las tres zonas, la muestra ligera ampliada (almacenamiento y conexión) y la geometría nueva.
4. **Panel principal nuevo:** accesos rápidos, fila de tarjetas con rueda y tamaños nuevos.
5. **Vistas simplificadas:** GitHub y GitLab (contribuciones y «Abrir»), Redmine (resumen, búsqueda y detalle), y la actualización de DESIGN.md y PRODUCT.md. Versión 0.3.0.

## Decisiones del constructor

Decisiones que el diseñador tomó por su cuenta (el usuario puede corregirlas al revisar):

- **Almacenamiento en la cápsula:** el % usado de la peor unidad fija (la misma que vigila el aviso de disco), con su letra («C: 62%»).
- **Conexión:** icono con y sin red; el tipo de enlace (wifi o ethernet) solo si main lo obtiene sin coste apreciable.
- **Toast de Windows:** se queda con el icono de la app; no se colorea.
- **Tarjeta de Claude Code:** sí existe, porque sin ella las sesiones desaparecen del panel.
- **Sistema:** su interruptor «Activa» solo quita la tarjeta y la vista; las métricas de la cápsula y los avisos del sistema siguen.
- **Búsqueda de Redmine por #número fuera de la caché:** usa el `GET /issues/{id}` que ya existe en `src-tauri/src/redmine/client.rs`.
- **Fórmulas de GitHub y GitLab:** sin cambios (ver la vista).

Decididas por el usuario (2026-11-17, aceptando las propuestas):

- **Datos de las tarjetas del panel:** al abrir el panel se piden una vez los datos que hoy solo se piden con la vista abierta (correos recientes de Gmail, contribuciones, resumen de Redmine y muestra completa de Sistema). Mientras llegan se muestra la caché. No hay sondeo adicional mientras el panel está abierto. Requiere cambios en main (Rust): una petición «panel abierto» por integración que reutilice las consultas de la vista, respetando los mínimos de refresco de cada una. Entra en la entrega 4.
- **Desactivar Claude:** el hook sigue instalado, pero el bridge deja de interceptar permisos y preguntas y responde sin decisión, de modo que Claude Code pregunta en su propia interfaz como si la notch no existiera. Desaparecen la tarjeta, el botón de acceso rápido, el bloque de la cápsula y las alertas. Ninguna sesión puede quedar bloqueada esperando a la notch con Claude desactivado; habrá una prueba que lo vigile.
- **Clic en una alerta de revisión:** si es una sola PR/MR, se abre en el navegador; si son varias, se abre la vista de contribuciones de esa plataforma. Las listas `toReview` y `mine` dejan de pedirse: main solo pide el recuento `unreviewed` (para la cápsula) y los cambios de estado que generan las alertas, con la URL de cada PR/MR para poder abrirla. Entra en la entrega 5, con sus pruebas de backend actualizadas.
