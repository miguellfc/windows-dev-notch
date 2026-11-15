# Configurar Redmine en Developer Notch

Developer Notch muestra tus tareas de **Redmine** y las horas que llevas imputadas con tu **clave de acceso API**. Se configura una vez, en un par de minutos.

Qué verás después: en la cápsula, las **horas imputadas hoy**; en la vista "Redmine" del notch (se abre desde el tile de Redmine del panel), el **resumen de horas** del mes y tus **tareas asignadas abiertas**, con su estado; y, a la hora que elijas, un **aviso de fin de jornada** si vas corto de horas. Desde la vista puedes cambiar el estado de una tarea, ajustar su estimación e **imputar horas**; un clic en "Abrir en Redmine" la abre en el navegador.

El notch actúa con **tu usuario**: solo puede hacer lo que Redmine te deja hacer a ti.

## 1. Activar la API REST (administrador)

La clave API solo funciona si el administrador de Redmine tiene activado el servicio web:

1. Como administrador, abre **Administración → Configuración → API**.
2. Marca **Activar el servicio web REST** y guarda.

Si no eres administrador y al guardar la clave ves "Clave no válida o API REST desactivada", pide a quien administre tu Redmine que lo active.

## 2. Obtener tu clave API

1. En Redmine, abre **Mi cuenta** (arriba a la derecha).
2. En la columna derecha, busca **Clave de acceso API** y pulsa **Mostrar**.
3. Copia la clave (son 40 caracteres hexadecimales). Si la pierdes o sospechas que otra persona la ha visto, pulsa **Restablecer** en ese mismo sitio: la anterior deja de valer.

## 3. Pegarla en el notch

1. Abre **Control Center → Redmine**.
2. Escribe la **URL de Redmine**, siempre con `https://` (por ejemplo `https://redmine.tuempresa.com`). Las direcciones `http://` se rechazan, y tampoco se admiten usuario, `?` ni `#`. Si tu Redmine vive en una subruta (`https://tuempresa.com/redmine`), inclúyela.
3. Pega la clave en **Clave de acceso API** (el ojo la muestra u oculta) y pulsa **Comprobar y guardar**.
4. Si todo va bien verás **Conectado como** *tu cuenta*, y el campo de la clave se vacía. En unos segundos aparecen las horas en la cápsula.

## Qué hace el notch con la clave

- Se guarda **solo en este equipo**, cifrada con el cifrado de Windows (`safeStorage`). Si el equipo no puede cifrar, la clave vive solo en memoria y habrá que pegarla de nuevo tras reiniciar (Control Center lo avisa).
- Solo se envía al servidor de Redmine que configuraste, en la cabecera `X-Redmine-API-Key` de cada petición.
- **Nunca se escribe en el registro** ni en ningún archivo en claro. Tampoco se registran los asuntos, comentarios ni enlaces de tus tareas: solo estados y cifras.
- Los títulos y comentarios de las tareas solo se tienen en memoria, mientras se muestran.

## Jornada y aviso de fin de jornada

En **Control Center → Redmine** hay dos ajustes:

- **Objetivo diario**: las horas que deberías imputar cada día (de 1 a 24, de 0,5 en 0,5; por defecto 8). El resumen del notch las usa para pintar cada día del mes.
- **Aviso de fin de jornada**: por defecto activado, a las **18:00**, con **sonido**. Puedes cambiar la hora y quitar el sonido; con el aviso apagado, la hora y el sonido se desactivan.

Cómo se comporta el aviso:

- Solo de **lunes a viernes**, a la hora local elegida. Los festivos no se distinguen.
- Si a esa hora llevas **menos horas que el objetivo**, la cápsula muestra "Llevas 5,5 h de 8 h hoy" durante unos segundos (con sonido si está activado, y aunque la cápsula esté oculta). Un clic en el aviso abre la vista Redmine. Si ya llegaste al objetivo, no avisa.
- **Una vez al día**: tras avisar (o comprobar que vas bien) no vuelve a hacerlo hasta el día siguiente.
- Si a la hora el equipo estaba **dormido o bloqueado** y despierta después, el notch todavía avisa durante la **hora siguiente** (1 h de margen); pasado ese margen, ese día ya no avisa.
- Si el notch **arranca después de la hora**, ese día no avisa: solo cuentan las horas de aviso que llegan con el notch en marcha.
- Necesita la sesión de Redmine activa y haber leído tus horas; sin conexión o con "Revisa la clave", el aviso espera a que haya datos dentro de ese margen.
- Si cambias la hora o vuelves a activar el aviso, solo cuenta a partir de ese momento: un cambio no dispara avisos del pasado.

## Quitar la clave

- En el notch: **Control Center → Redmine → Quitar** borra la clave de este equipo y el notch deja de consultar Redmine.
- En el servidor (para invalidarla del todo): en Redmine, **Mi cuenta → Clave de acceso API → Restablecer**.

## Problemas frecuentes

| Qué ves | Qué pasa | Qué hacer |
|---|---|---|
| "Clave no válida o API REST desactivada" al guardar | Clave mal copiada, restablecida o API REST apagada | Copia la clave entera de **Mi cuenta** y pide al administrador que active la API REST |
| "La URL debe empezar por https://" | La URL usa `http://` o tiene usuario, `?` o `#` | Escribe solo la dirección del servidor con `https://` |
| "Sin conexión con Redmine" | No hay red, el servidor no responde o la URL no es de un Redmine | Comprueba la red y la URL; el notch reintenta solo |
| "Revisa la clave" | La clave se restableció o se desactivó la API | Copia la clave nueva y pulsa **Comprobar y guardar** |
| Falta una tarea | Solo salen las **abiertas asignadas a ti** (las 300 más recientes) | Comprueba su estado y su responsable en Redmine |
| "Redmine no te deja hacer este cambio" | Tu rol no permite ese cambio o esa imputación | Pide el permiso en el proyecto |
| El aviso no suena o no sale | Es fin de semana, ya llegaste al objetivo, el notch arrancó después de la hora, pasó la hora de margen o el aviso está apagado | Revisa **Aviso de fin de jornada** en Control Center |
