# Monitor del sistema — Hito 2: avisos por umbral — Diseño

**Fecha:** 2026-11-11 · **Rama:** `feat/system-alerts` (desde `dev`)
**Fuentes:** `docs/superpowers/specs/2026-11-10-system-monitor-design.md` (núcleo, hito 1), PRD (sección "System Monitor (núcleo)"), `DESIGN.md`.

## Objetivo

Que el usuario vea sin buscarlo cuándo el equipo va justo: la métrica que pasa su umbral se **pinta en rojo** en la cápsula, sin interrumpir.

## Decisiones (tomadas con el usuario)

| Tema | Decisión |
|---|---|
| Cómo se avisa | **Icono y cifra de la métrica en Rojo Fallo** dentro de la cápsula compacta. Sin modo `alert`, sin toast, sin sonido; un aviso nunca abre la cápsula |
| Umbrales | Valores por defecto **ajustables** en una nueva página **Control Center → Sistema**; cada aviso se puede desactivar |
| Dónde se evalúa | **En main**, junto al muestreo (enfoque A): un único resultado para cápsula y vista |
| Disco | Hoy no está en la cápsula: aparece un icono `HardDrive` con la unidad y el % libre **solo mientras** está por debajo del umbral |

## Umbrales por defecto

| Aviso | Se pone en rojo cuando | Vuelve a normal cuando (histéresis) |
|---|---|---|
| CPU | todas las muestras de los últimos **30 s** son ≥ **90 %** | una muestra < 85 % |
| RAM | uso ≥ **90 %** | uso < 85 % |
| Batería | ≤ **15 %** y **no** enchufada | > 20 % o enchufada |
| Disco | alguna unidad fija con < **10 %** libre (se informa la peor) | todas con ≥ 15 % libre |

La histéresis es fija (5 puntos) y evita el parpadeo alrededor del umbral. Sin batería, el aviso de batería nunca se activa.

## Ajustes

`settings.json` pasa a **versión 3** (migración 2 → 3 que añade los valores por defecto):

```ts
systemAlerts: {
  cpu:     { enabled: true, percent: 90 /* 50–100 */, sustainSeconds: 30 /* 5–300 */ },
  ram:     { enabled: true, percent: 90 /* 50–99 */ },
  battery: { enabled: true, percent: 15 /* 5–50 */ },
  disk:    { enabled: true, freePercent: 10 /* 1–50 */ },
}
```

Un cambio de ajustes se aplica en la siguiente muestra (main lee los ajustes en vivo).

## Arquitectura

### Main

- **`src/main/system/alerts.ts`** (puro): `createAlertEvaluator()` → `{ evaluate(input: { cpuPercent, ramPercent, battery, disks, now }, settings: SystemAlertSettings): SystemAlerts; reset(): void }`.
  - Guarda la ventana de CPU (marcas de tiempo + valores) solo durante `sustainSeconds`; una muestra de CPU `null` no cuenta como alta.
  - Aplica la histéresis por aviso (estado anterior + umbral de salida).
  - `SystemAlerts = { cpu: boolean; ram: boolean; battery: boolean; disk: { letter: string; freePercent: number } | null }`.
- **`system-monitor.ts`**: en cada muestra (ligera o completa) llama al evaluador y adjunta `alerts` a la muestra emitida.
  - **Disco en segundo plano**: el ritmo ligero consulta el espacio de las unidades fijas cada **60 s** (llamadas de microsegundos; sin PDH) y reutiliza el último resultado entre medias; el ritmo completo ya trae `disks`.
  - Con el muestreo en pausa (`mini`, `hidden`, `alert`) no se evalúa nada; al reanudar tras ≥ 10 s se hace `reset()` del evaluador (como el de CPU).
- **Esquema**: `lightSampleSchema` y `fullSampleSchema` ganan `alerts: systemAlertsSchema`.

### Notch

- **Cápsula** (`CapsuleMetrics`): para cada métrica con aviso, icono y cifra en Rojo Fallo; el resto igual. Con `alerts.disk`, un bloque `HardDrive` + `C: 6 %` en rojo. La etiqueta accesible añade "alta"/"high" o "baja"/"low" (p. ej. "RAM 93 %, alta").
  - El **latch** de la cápsula (3 fallos) también se aplica al bloque de disco para que no aparezca y desaparezca por una sola lectura.
  - Anchos: se añade el ancho con disco al cálculo (`COMPACT_WIDTHS`), medido en ES/EN con el peor caso (`Z: 100 %`); el cambio de ancho usa el mismo fundido que ya existe.
- **Vista "Sistema"**: la tarjeta de CPU, RAM o batería en aviso muestra su cifra en Rojo Fallo; la línea de la unidad en aviso, también.

### Control Center

- **Nueva página "Sistema"** (icono `Activity`): por aviso, un `Switch` y un campo numérico con su rango; para CPU, además los segundos sostenidos. Texto breve que explica el margen de vuelta a normal. Escritura con `settings:update` (parche completo de `systemAlerts`).

## Seguridad y privacidad

Sin cambios respecto al núcleo: no se registran nombres de procesos; los avisos solo usan cifras agregadas; los ajustes se validan con zod en main.

## Coste

La evaluación es aritmética sobre la muestra existente. La consulta de espacio en disco añade unas pocas llamadas Win32 cada 60 s solo mientras la cápsula se mide. Objetivo: CPU de la app en reposo sigue ≈ 0 % (medido como en el hito 1).

## Pruebas

- **Unitarias**: evaluador (CPU sostenida justo en 30 s y una muestra baja que la corta; `null` no cuenta; histéresis de cada aviso; batería enchufada o ausente; disco con la peor unidad; avisos desactivados; `reset`), migración 2 → 3, esquemas, monitor (adjunta `alerts`, consulta de disco cada 60 s y reutilización), latch del bloque de disco, anchos de la cápsula.
- **E2E**: con ajustes sembrados en umbrales muy bajos (p. ej. RAM 50 %), la cifra de RAM de la cápsula aparece en rojo; al subir el umbral desde la página de Control Center, vuelve a normal; capturas ES/EN de la cápsula con avisos y de la página de ajustes.

## Criterios de aceptación

1. Una métrica por encima de su umbral se ve en rojo en la cápsula en ≤ 3 s (CPU: tras el tiempo sostenido).
2. No parpadea alrededor del umbral (histéresis de 5 puntos).
3. Con poco espacio en disco aparece el icono de disco en rojo y desaparece al liberar espacio.
4. Los umbrales se cambian y desactivan en Control Center → Sistema y se aplican sin reiniciar.
5. Ningún aviso abre la cápsula, lanza un toast ni suena; la CPU en reposo sigue ≈ 0 %.

## Fuera de alcance

Toasts, sonidos o modo alerta para estos avisos; avisos por proceso; temperaturas y GPU; batería de dispositivos Bluetooth (hito 3).
