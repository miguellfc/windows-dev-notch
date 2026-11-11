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
- **Filo** (rgba(255,255,255,.08)): bordes de 1 px y divisores.
- **Tiza** (#EDEDEF): texto principal.
- **Grafito** (#8B8B93): texto secundario, etiquetas, tiempos, hints de teclado.

### Estados
- **Verde Listo** (#4ADE80): terminado / OK; aparece de forma breve.
- **Ámbar Espera** (#FBBF24): esperando permiso o input; pulsa mientras haya algo pendiente. Texto sobre él: #1A1205 (token `--color-on-wait`).
- **Rojo Fallo** (#F87171): error.

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
**The Short Scale Rule.** Solo existen 11 / 12.5 / 13 / 15 px. Si algo necesita otro tamaño, la jerarquía está mal resuelta.

**The Mono Is Data Rule.** Geist Mono solo para valores que el usuario lee como dato (hora, ruta, duración, atajo); nunca para etiquetas ni títulos.

## Layout

Escala de espaciado en múltiplos de 4 px. El panel usa padding de 14 px y separaciones de 8 px entre elementos hermanos y 12 px entre bloques. Los favoritos se muestran en una cuadrícula de 4 columnas con gaps de 8 px.

La cápsula está centrada en el borde superior del monitor donde está el cursor y se posiciona en píxeles independientes de densidad (100/125/150 %). La ventana de la cápsula mide lo mismo que la cápsula visible más el margen que necesita la sombra: fuera de ese margen no debe haber área que bloquee clicks.

Los tamaños exactos de la cápsula (compacta ~36 px de alto, alerta ~44 px) y el ancho del panel (~440 px en las maquetas) son orientativos: `[to be resolved during implementation]`.

Todo texto pasa por i18n: las filas truncan con elipsis y nunca saltan de línea en la cápsula; el panel se dimensiona para la cadena más larga entre español e inglés.

## Elevation & Depth

Profundidad por sombra profunda y difusa más un brillo interior de 1 px en el borde superior, sobre una superficie casi opaca. No hay desenfoque real del escritorio: en una ventana transparente de Electron `backdrop-filter` no desenfoca lo que hay detrás, así que el efecto cristal viene de la opacidad, el filo de 1 px y la sombra. La cápsula pequeña usa ~86 % porque apenas tapa nada; el panel expandido es opaco porque cualquier transparencia deja que el texto de las ventanas de detrás compita con el del panel (medido en M1: al 95 % todavía se leía). El Control Center, que es una ventana rectangular normal, usa el material Mica nativo de Windows 11.

### Shadow Vocabulary
- **Levitación** (`box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 18px 50px rgba(0,0,0,.55)`): cápsula compacta, alerta y panel expandido.
- **Levitación Baja** (`box-shadow: 0 2px 6px rgba(0,0,0,.4)`): solo la píldora `mini`; con la sombra completa deja un halo visible debajo de una pieza de 6 px.

### Named Rules
**The Denser When Busier Rule.** Cuanto más texto muestra una superficie, más opaca es: la cápsula puede dejar intuir el fondo, el panel no. Nunca se lee contenido ajeno a través de Developer Notch.

**The No Glow Rule.** Nada emite luz: sin glow de color, sin bordes luminosos, sin gradientes de neón. El único halo permitido es el anillo de 3 px al 22–25 % de opacidad alrededor del punto de estado.

## Shapes

Formas redondeadas y blandas que anidan con coherencia: la cápsula es una píldora completa (999px); el panel, 24 px; las tarjetas, 16 px; los tiles e input del buscador, 14 px; los controles pequeños (kbd, chips), 6–10 px. Bordes siempre de 1 px con el color Filo. Los iconos son Lucide con trazo de 1.8 px a 16 px (13 px en la cápsula); sin emojis.

**The Nested Radius Rule.** El radio interior es el exterior menos el padding; nada dentro del panel puede ser más redondo que el panel.

## Do's and Don'ts

### Do:
- **Do** anima el morph cápsula→panel con un spring (stiffness ~380, damping ~32; ~350 ms), animando solo `transform`, `opacity` y `clip-path`.
- **Do** cierra más rápido de lo que abres (~180 ms, ease-out).
- **Do** entra el contenido del panel con un escalonado leve (30 ms entre tarjetas).
- **Do** usa un único ensanche al llegar una alerta y un pulso de 1.6 s en el punto mientras siga pendiente.
- **Do** reduce todo a fundidos de opacidad con `prefers-reduced-motion`.
- **Do** muestra el foco de teclado con un anillo de 2 px en Azul Hielo, siempre.
- **Do** mantén el contraste de texto ≥ 4.5:1 sobre Obsidiana.

### Don't:
- **Don't** animes `width`, `height` ni posición de layout; no rebotes ni overshoot en las alertas.
- **Don't** uses glow, neón, bordes luminosos ni gradientes decorativos.
- **Don't** tiñas las superficies de color; el negro es neutro.
- **Don't** muestres huecos vacíos ni "próximamente": un módulo sin nada que decir no ocupa espacio.
- **Don't** construyas identidad sobre el nombre "Developer Notch"; es provisional.
- **Don't** cargues fuentes ni iconos desde la red.
