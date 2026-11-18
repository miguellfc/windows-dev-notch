# Polish 0.3.0 (style base)

## 1. Jersey 10 solo en cifras grandes
- Causa: a 17px Jersey se ve borroso.
- Cambio: tablas de Contribuciones (ContributionSummary.tsx, `font-mono tabular text-small`) y resumen de Redmine (RedmineSummary.tsx, `font-mono tabular text-body font-medium`) vuelven a mono con el tamano previo a la rama. Cifras de Sistema en la rejilla de 4 columnas (con bateria): `font-mono tabular text-body font-medium`; en 3 columnas siguen en Jersey 26px (`digits text-digits-lg`). La clase `digits` ya no esta en `value`/`alertValue` sino en el tamano de 26px. Eliminado `--text-digits` (17px) de global.css; ningun test lo referenciaba. Jersey se mantiene en el reloj (20px) y en "Proximo" (26px).
- Encaja en ES/EN (comprobado con la captura en ES; las tablas usan whitespace-nowrap y las columnas caben).

## 2. Puntuacion suelta en Sistema
- Causa: la sparkline. Con 2-7 muestras y la escala fija de 60 muestras, el trazo medido era un segmento sub-pixel en el borde derecho (con puntas redondas), que se leia como "," o ".".
- Cambio (Sparkline.tsx): no se dibuja hasta tener 8 muestras (MIN_POINTS) y, mientras el bufer se llena, el viewBox se ajusta al numero de muestras (la linea ocupa todo el ancho). Con 60 muestras es identico a antes.

## 3. Hueco en el detalle de Redmine
- Causa: la linea de feedback (24px, `pl-[109px]`) estaba entre las tarjetas Estimacion e Imputar.
- Cambio (RedmineIssueDetail.tsx): la linea esta ahora dentro de la tarjeta Estimacion, como segunda fila del grid en la columna 2 (alineada bajo los controles), `-mt-1 min-h-4` (siempre montada, 16px reservados). Testids `redmine-detail-task-done/-error/-retry` intactos. Imputar sube ~12px; el hueco desaparece.

## 4. DESIGN.md
Digits: Jersey solo reloj (20px), "Proximo" y Sistema a 26px; tablas y Sistema de 4 columnas en Geist Mono tabular; reglas Short Scale y Mono Is Data y la descripcion del panel Sistema actualizadas (incluye la regla de la sparkline).

## Verificacion
- `npx vitest run`: 59 archivos, 875 tests OK. `npm run typecheck`, `npm run lint`, `npm run build:tauri-renderer`: OK.
- e2e (system, code-review, redmine, reminders, app): ver resultado en la respuesta final.
- Nota: el binario e2e incrusta el frontend; hay que reconstruirlo (`tauri build --debug --no-bundle --features e2e`) antes de capturar con `wdio` directo.
- Capturas (carpeta v030-screens): 05-system-v2.png (3 s, sin sparkline aun), 05-system-v2-later.png (15 s, sparkline limpia), 12-reviews-github-v2.png, 13-redmine-list-v2.png, 14-redmine-detail-v2.png. Spec temporal tmp-shots.spec.ts eliminado.
