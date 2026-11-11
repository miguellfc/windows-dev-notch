---
name: Developer Notch
description: Cápsula de atención para desarrolladores en Windows; estado de agentes y acción rápida sin salir del trabajo.
---

<!-- SEED: established with the user before implementation; re-run /impeccable document once there's code to capture the actual tokens and components. -->

# Design System: Developer Notch

## Overview

**Creative North Star: "Obsidian"**

Una pieza de cristal negro pulido que descansa en el borde superior de la pantalla: casi opaca, fría, silenciosa. No decora el escritorio; está ahí para decir una sola cosa importante y apartarse. Toda la jerarquía se resuelve con tipografía, espaciado y una única nota de color; el color de estado aparece solo cuando significa algo (Claude espera, algo falló, algo terminó).

Escena física que fija el modo oscuro: un desarrollador frente a uno o varios monitores durante toda la jornada, con IDE y terminales en tema oscuro, luz de oficina o de casa variable; la cápsula vive encima de ese trabajo y no puede ser la superficie más brillante de la pantalla. Modo oscuro es la experiencia principal; un modo claro no está decidido y no debe asumirse.

Densidad media-alta y escala pequeña, como un instrumento de precisión: textos cortos, alineaciones exactas, nada de relleno. El movimiento es físico y breve: la cápsula se transforma en panel como un mismo objeto que crece, y vuelve más rápido de lo que se abrió.

**Key Characteristics:**
- Negro neutro casi opaco, sin tinte de color en las superficies.
- Un solo acento frío (azul hielo) para selección, foco y badge.
- Color de estado reservado a estados con significado.
- Sin brillos, neones ni bordes luminosos; profundidad por sombra profunda y un brillo interior de 1 px.
- Teclado primero: el foco siempre es visible.
- Copy bilingüe (ES/EN): los componentes se dimensionan para la cadena más larga.

## Colors

Estrategia Restrained: neutros negros sin tinte más un acento, y una familia de estados que solo aparece cuando hay algo que comunicar. Valores establecidos con el usuario en el brainstorming; se convertirán en tokens en la primera pasada de `/impeccable document` sobre código real.

### Primary
- **Azul Hielo** (#7DD3FC): selección activa, anillo de foco, caret del buscador, badge de pendientes y estado "trabajando". Texto sobre él: **Abismo Azul** (#06202B).

### Neutral
- **Obsidiana** (rgba(14,14,16,.86)): superficie de la cápsula compacta, la alerta y la píldora `mini`.
- **Obsidiana Densa** (#0E0E10, opaca): superficie del panel expandido. Sin desenfoque real, el texto de la ventana de detrás se lee a través del 86 % (spike M0) e incluso del 95 % (QA de M1), así que el panel es totalmente opaco.
- **Velo** (rgba(255,255,255,.04)): superficies elevadas dentro del panel (buscador, tiles, tarjetas).
- **Velo Tile** (rgba(255,255,255,.06)): fondo de los iconos de favoritos.
- **Velo Hover** (rgba(255,255,255,.09)): hover de las superficies Velo Tile (tiles, chips, botones secundarios). Token `--color-veil-hover`.
- **Filo** (rgba(255,255,255,.08)): bordes de 1 px y divisores.
- **Tiza** (#EDEDEF): texto principal.
- **Grafito** (#8B8B93): texto secundario, etiquetas, tiempos, hints de teclado.
- **Grafito Cristal** (#A3A3AB): texto secundario sobre la Obsidiana translúcida (fecha de la cápsula compacta, herramienta de la alerta, teclas del peek, "+N" de los puntos). Sobre la Obsidiana al 86 % encima de una ventana blanca da 5,3:1 (4,7:1 sobre Velo), donde Grafito se queda en 3,9:1. Token `--color-graphite-glass`; en las superficies opacas se sigue usando Grafito.

### Estados
- **Verde Listo** (#4ADE80): terminado / OK; aparece de forma breve.
- **Ámbar Espera** (#FBBF24): esperando permiso o input; pulsa mientras haya algo pendiente. Texto sobre él: #1A1205 (token `--color-on-wait`).
- **Rojo Fallo** (#F87171): error; y métrica por encima de su umbral (avisos del sistema): solo icono y cifra en la cápsula compacta y la cifra en la vista Sistema; nunca superficie ni borde; contraste ≈ 4,8:1 sobre Obsidiana encima de una ventana blanca.

### Named Rules
**The One Voice Rule.** El Azul Hielo es la única nota de color fuera de los estados; si una pantalla parece colorida, algo sobra.

**The Meaningful Color Rule.** Verde, ámbar y rojo solo aparecen ligados a un estado real; nunca como decoración, iconos de categoría ni fondos. Un estado nunca depende solo del color: siempre lo acompaña texto o icono.

## Typography

**Body Font:** Geist (fallback: Segoe UI Variable, system-ui, sans-serif)
**Label/Mono Font:** Geist Mono (fallback: Cascadia Mono, Consolas, monospace)

Ambas fuentes van empaquetadas en la app; nunca se cargan desde un CDN.

**Character:** Una grotesca neutra y precisa para la UI y su mono hermana para lo que se lee como dato (hora, rutas, tiempos, atajos). Juntas suenan técnicas sin disfrazarse de terminal.

### Hierarchy
- **Title** (600, 15px): títulos de sección del Control Center; no se usa en la cápsula.
- **Body** (400/500, 13px): nombres de favoritos y sesiones, texto del buscador, mensaje de alerta.
- **Body Small** (400, 12.5px): descripción de sesión, fecha.
- **Label** (500, 11px; 10.5px en mayúsculas con tracking 0.09em): etiquetas de sección ("FAVORITOS", "CLAUDE CODE"), nombres bajo iconos.
- **Data** (Geist Mono 400/500, 11–13px): hora, rutas, tiempos transcurridos, teclas.

### Named Rules
**The Short Scale Rule.** Solo existen 11 / 12.5 / 13 / 15 px. Si algo necesita otro tamaño, la jerarquía está mal resuelta. Única excepción: las etiquetas de grupo en mayúsculas, a 10.5 px con tracking 0.09em (token `text-caps`, que ya lleva el tracking), porque la mayúscula pesa ópticamente más que la minúscula al mismo tamaño.

**The Mono Is Data Rule.** Geist Mono solo para valores que el usuario lee como dato (hora, ruta, duración, atajo); nunca para etiquetas ni títulos.

## Layout

Escala de espaciado en múltiplos de 4 px: 1rem = 16 px (el tamaño de 13 px del cuerpo se fija en `body`, nunca en `html`, para no encoger toda la escala). Todo objetivo interactivo mide al menos 24×24 px (WCAG 2.5.8): filas de sesión de 24 px, botones de icono de 24–28 px, Switch de 40×24. El panel usa padding de 14 px y separaciones de 8 px entre elementos hermanos y 12 px entre bloques. Los favoritos se muestran en una cuadrícula de 4 columnas con gaps de 8 px.

La cápsula está centrada en el borde superior del monitor donde está el cursor y se posiciona en píxeles independientes de densidad (100/125/150 %). La ventana de la cápsula tiene un ancho fijo (la cápsula más ancha, 640 px, más 56 px de margen de sombra por lado = 752 px) y el alto de la cápsula visible más el margen de sombra (6 px arriba, 72 px abajo, para que la cola de `0 18px 50px` no se recorte). Como solo cambia el alto, «crecer» y «encoger» se deciden por el alto de la ventana (no por el área): al crecer se agranda la ventana y después se anima; al encoger se anima y después se achica, y la curva (spring de apertura o cierre de 200 ms) sigue la misma regla. El área transparente nunca bloquea clicks: la ventana ignora el ratón salvo cuando el puntero está sobre la cápsula.

Los tamaños exactos de la cápsula (compacta ~36 px de alto, alerta ~44 px) y el ancho del panel (~440 px en las maquetas) son orientativos: `[to be resolved during implementation]`.

Todo texto pasa por i18n: las filas truncan con elipsis y nunca saltan de línea en la cápsula; el panel se dimensiona para la cadena más larga entre español e inglés.

**Cápsula compacta con métricas (System Monitor).** Además de hora y fecha, la cápsula compacta muestra CPU, RAM y batería (hora · fecha · CPU · RAM · batería), cada métrica con un icono Lucide de 12 px (más pequeño que los 13 px del resto de la cápsula, para que quepan cinco datos). Los valores usan cifras tabulares en Grafito Cristal y reservan el ancho de "100 %" para que el número al cambiar no empuje a sus vecinos. El ancho de la cápsula depende del contenido y solo tiene cinco valores (`COMPACT_WIDTHS` en `src/shared/notch/geometry.ts`): 168 px sin métricas (sin muestra aún o monitor no disponible: la cápsula original de hora y fecha), 299 px con CPU y RAM sin batería (el hueco de la batería se elimina), 358 px con batería, 376 px con el bloque de disco sin batería y 435 px con batería y disco. El bloque de disco (icono `HardDrive` + "C: 6 %", el % libre de la peor unidad fija, siempre en Rojo Fallo) solo existe mientras el aviso de disco está enganchado: va después de la batería, reserva el ancho de "W: 100 %", aparece con la primera muestra que trae el aviso y se va tras 3 muestras sin él (~9 s). Los colores de aviso nunca cambian el ancho; el bloque de disco es lo único que añade un hueco. Un latch (`capsule-latch`) evita que el ancho parpadee: un valor que desaparece se conserva hasta que falta 3 veces seguidas (`CAPSULE_MISSES`), y solo entonces la cápsula encoge. Al cambiar de ancho el contenido se cruza con el fundido habitual (nunca se anima `width`, ver Don'ts).

**Panel "Sistema" (520×280).** Se abre desde el icono de integraciones, como la terminal. Arriba, tarjetas de CPU, RAM y batería, cada una con una sparkline de los últimos 60 s sin animación (se redibuja con cada muestra, sin transiciones). Debajo, una línea con los discos. Debajo, la lista de los 5 procesos que más consumen (cambio del usuario, 2026-11-11: antes 8; el panel pasó de 520×360 a 520×280): el botón "Cerrar" aparece solo al pasar el ratón o al enfocar la fila, y solo en procesos que se pueden cerrar. Pulsarlo abre una confirmación en línea en la propia fila, con "Cerrar" a la izquierda de "Cancelar"; el foco va a "Cancelar" y "Cerrar" no responde durante los primeros 300 ms (`CONFIRM_ARM_MS`, para que un doble click o una tecla repetida no confirme sin querer). El resultado (cerrado, ya no existe, no se pudo cerrar) se muestra como mensaje en la fila. Avisos del sistema: una métrica pasa a Rojo Fallo solo cuando cruza su umbral (por defecto CPU ≥ 90 % sostenido 30 s, RAM ≥ 90 %, batería ≤ 15 % desenchufada, peor unidad fija < 10 % libre) y vuelve a Tiza cuando regresa 5 puntos al lado seguro (histéresis fija de 5 puntos). Los umbrales se ajustan y se desactivan uno a uno en Control Center → Sistema. No hay ámbar ni estados intermedios: el color de estado solo significa un estado real (The Meaningful Color Rule). En la vista Sistema la cifra de la tarjeta en aviso se pinta en rojo (la etiqueta sigue en Grafito) y la línea del disco en aviso pinta en rojo su % USADO, mientras la cápsula compacta muestra el % LIBRE de esa unidad: son la misma condición contada desde lados distintos, cada una en el formato de su línea.

**Control Center → "Sistema".** Una fila por aviso (CPU, RAM, batería, disco) con un interruptor y un campo de número entero para el umbral (más un segundo campo para los segundos sostenidos de CPU). Los campos se alinean en columnas fijas (número + unidad alineada a la izquierda) y el interruptor queda a la altura del primer campo. Un valor no entero o fuera de rango muestra el rango permitido bajo el campo y no guarda nada (nunca se recorta al rango); un valor válido se guarda al pulsar Enter o al salir del campo. Con el aviso desactivado los campos quedan atenuados, de solo lectura y descartan cualquier borrador o error.

## Elevation & Depth

Profundidad por sombra profunda y difusa más un brillo interior de 1 px en el borde superior, sobre una superficie casi opaca. No hay desenfoque real del escritorio: en una ventana transparente de Electron `backdrop-filter` no desenfoca lo que hay detrás, así que el efecto cristal viene de la opacidad, el filo de 1 px y la sombra. La cápsula pequeña usa ~86 % porque apenas tapa nada; el panel expandido es opaco porque cualquier transparencia deja que el texto de las ventanas de detrás compita con el del panel (medido en M1: al 95 % todavía se leía). El Control Center, que es una ventana rectangular normal, usa el material Mica nativo de Windows 11, siempre en su variante oscura: el proceso main fija `nativeTheme.themeSource = 'dark'`, así que un tema claro de Windows nunca pone texto Tiza sobre Mica claro.

### Shadow Vocabulary
- **Levitación** (`box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 18px 50px rgba(0,0,0,.55)`): cápsula compacta, alerta y panel expandido.
- **Levitación Baja** (`box-shadow: 0 2px 6px rgba(0,0,0,.4)`): solo la píldora `mini`; con la sombra completa deja un halo visible debajo de una pieza de 6 px.
- Fuente única: `src/renderer/notch/motion.ts`. La sombra exterior es un `filter: drop-shadow()` en un contenedor que no se escala, para que el morph no la estire; el brillo de 1 px sigue siendo un `box-shadow` inset en la cápsula.

### Named Rules
**The Denser When Busier Rule.** Cuanto más texto muestra una superficie, más opaca es: la cápsula puede dejar intuir el fondo, el panel no. Nunca se lee contenido ajeno a través de Developer Notch.

**The No Glow Rule.** Nada emite luz: sin glow de color, sin bordes luminosos, sin gradientes de neón. El único halo permitido es el anillo de 3 px al 22–25 % de opacidad alrededor del punto de estado.

## Shapes

Formas redondeadas y blandas que anidan con coherencia: la cápsula es una píldora completa (radio = mitad de su altura, nunca 999px, para que el radio se anime con el morph); el panel, 24 px; las tarjetas, 16 px; los tiles e input del buscador, 14 px; los controles (botones, campos, Segmented), 10 px; los botones de icono pequeños y las opciones anidadas dentro de un control de 10 px, 8 px (token `--radius-control-sm`); las teclas (kbd), 6 px (`--radius-key`); el icono de la app en Acerca de, 12 px (`--radius-icon`). Bordes siempre de 1 px con el color Filo. Los iconos son Lucide con trazo de 1.8 px a 16 px (13 px en la cápsula); sin emojis.

**The Nested Radius Rule.** El radio interior es el exterior menos el padding; nada dentro del panel puede ser más redondo que el panel.

## Do's and Don'ts

### Do:
- **Do** anima el morph cápsula→panel con un spring (`visualDuration` 0.32 s, `bounce` 0.1) y los crecimientos pequeños (peek, alerta, compacta, mini) con un spring de 0.22 s sin rebote; el radio (24 px ↔ mitad de la altura) se anima con la misma curva. Anima solo `transform`, `opacity` y `clip-path` (más el radio y la sombra que Motion corrige por la escala).
- **Do** cierra más rápido de lo que abres (200 ms, `cubic-bezier(0.23, 1, 0.32, 1)`).
- **Do** cruza el contenido sin doble exposición (sale en 90 ms; entra en 180 ms tras 60 ms de espera, al crecer y al encoger) y entra el del panel con un escalonado leve (30 ms entre secciones, opacidad + 4 px), sin bloquear clics.
- **Do** mantén constante el ancho de la ventana del notch (cápsula más ancha + márgenes de sombra): Motion omite las animaciones de layout durante 250 ms cuando cambia `innerWidth`.
- **Do** usa un único ensanche al llegar una alerta y un pulso de 1.6 s en el punto mientras siga pendiente.
- **Do** reduce todo a fundidos de opacidad con `prefers-reduced-motion`.
- **Do** muestra el foco de teclado con un anillo de 2 px en Azul Hielo, siempre.
- **Do** mantén el contraste de texto ≥ 4.5:1 sobre Obsidiana, también sobre la Obsidiana translúcida encima de una ventana blanca (Grafito Cristal para el texto secundario).
- **Do** deja que un aviso del sistema solo cambie colores (y, el de disco, añada su bloque): un aviso nunca abre la cápsula, cambia de modo, muestra un toast ni suena.
- **Do** usa un único punto de Tab por grupo de opciones (Segmented): las flechas mueven y seleccionan, como el patrón Radio Group de WAI-ARIA.

### Don't:
- **Don't** animes `width`, `height` ni posición de layout; no rebotes ni overshoot en las alertas.
- **Don't** uses glow, neón, bordes luminosos ni gradientes decorativos.
- **Don't** tiñas las superficies de color; el negro es neutro.
- **Don't** abras la cápsula, cambies de modo, lances un toast ni hagas sonar nada por un aviso del sistema; tampoco tiñas superficies ni bordes con su rojo.
- **Don't** muestres huecos vacíos ni "próximamente": un módulo sin nada que decir no ocupa espacio.
- **Don't** construyas identidad sobre el nombre "Developer Notch"; es provisional.
- **Don't** cargues fuentes ni iconos desde la red.
