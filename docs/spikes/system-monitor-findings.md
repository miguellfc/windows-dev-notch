# Prueba de llamadas Win32/PDH para el monitor de sistema (Task 0)

Script: `spikes/system-monitor/probe.cjs` (`node spikes/system-monitor/probe.cjs`). Entorno: Windows 11 x64, Node 22.23.3, koffi 3.3.6, 16 núcleos, sesión 1. Todas las llamadas funcionan con koffi; ninguna falló.

## Valores obtenidos (esta máquina)

| Métrica | Resultado |
|---|---|
| CPU total (1 s entre dos `GetSystemTimes`) | 3 % |
| RAM | total 16 477 696 000 B, usada 13 800 751 104 B (`dwMemoryLoad` 83 %) |
| Batería | **Sí hay batería**: `ACLineStatus` 1, `BatteryFlag` 1, 99 %, `BatteryLifeTime` 0xFFFFFFFF (= desconocido, hay que tratarlo como `null`) |
| Discos | solo `C:\` (tipo 3): 952 GB total, 370,5 GB libres |
| Disco actividad PDH | 0,6 % (100 − `% Idle Time`) |
| Red PDH | 2 instancias (Wi-Fi MediaTek, Realtek GbE); ↑ 325,7 B/s, ↓ 1884,3 B/s sumando instancias |
| Procesos | 289 en el snapshot; 165 abiertos con `PROCESS_QUERY_LIMITED_INFORMATION` |
| CPU por proceso (Δ 1 s / núcleos) | coherente (claude.exe 0,7 %, webstorm64 0,3 %) |
| Memoria privada | coherente (webstorm64 2641 MB, claude.exe 863 MB) |
| Dueño | los 165 abiertos son del usuario actual (EqualSid true), todos en la sesión 1, ninguno crítico |
| Terminar proceso | proceso hijo propio (`ping`): abierto con `PQLI\|PROCESS_TERMINATE`, dueño = yo, `IsProcessCritical` false, `TerminateProcess` true, salida observada; después `OpenProcess` del PID muerto falla (devuelve null) |

## Costes (`process.hrtime.bigint()`)

| Muestra | Media | Máx | Objetivo |
|---|---|---|---|
| Ligera (CPU+RAM+batería), 100 iteraciones | 0,232 ms | 1,631 ms (mín 0,074) | < 2 ms OK |
| Lectura PDH (collect + disco + 2 arrays de red), 20 iter. | 2,08 ms | 2,46 ms | ver nota |
| Lista de procesos completa (snapshot + abrir/tiempos/mem/crítico/sesión/token de cada uno), 20 iter. | 14,07 ms | 18,24 ms | < 20 ms OK (margen justo) |

Nota: el PDH (≈ 2 ms) forma parte de la muestra completa, no de la ligera. El máximo de proceso (18,2 ms) está bajo 20 ms pero con poco margen; el coste crece con el número de procesos. No se midió el desglose; se supone que la mayor parte está en las ~6 llamadas por proceso (`OpenProcess`, token, tiempos, memoria). Si hiciera falta recortar, abrir el token solo para el top tras ordenar por CPU/RAM (no medido).

## Fallos y rarezas

- `OpenProcess(PQLI)` denegado en **124 de 289** procesos (sistema, servicios, elevados, protegidos). Son todos ajenos al usuario actual: ninguno de los 165 abiertos era ajeno, así que "no se puede abrir" ⇒ tratar como no matable y omitir de la lista (o mostrar sin CPU/RAM). No hubo fallos en `GetProcessTimes`, `K32GetProcessMemoryInfo`, `IsProcessCritical`, `OpenProcessToken` ni `ProcessIdToSessionId` en procesos abiertos.
- `PdhGetFormattedCounterArrayW` devuelve `PDH_MORE_DATA` (0x800007D2) en la primera llamada con buffer nulo; declarado como `uint32` comparar directamente; la prueba usa `>>> 0` por seguridad.
- PDH necesita **dos** `PdhCollectQueryData` separadas ≥ 1 s antes de leer tasas (la prueba siempre hizo dos; no se midió el comportamiento con una sola).
- `BatteryLifeTime` = 4294967295 si no se conoce; `BatteryFlag` 128 = sin batería, 255 = desconocido.
- Las instancias de red incluyen adaptadores virtuales en otras máquinas; sumar todas puede duplicar tráfico (aquí no ocurre: solo 2 instancias).

## Declaraciones koffi para la Task 2

Prefijo `NOTCH_` en structs; registrar con `ensureKoffiType`. DLL: `kernel32.dll`, `advapi32.dll`, `pdh.dll`.

```js
const FILETIME = koffi.struct('NOTCH_FILETIME', { lo: 'uint32', hi: 'uint32' })        // ft = BigInt(hi) * 2n**32n + BigInt(lo)
koffi.struct('NOTCH_MEMORYSTATUSEX', { dwLength: 'uint32', dwMemoryLoad: 'uint32', ullTotalPhys: 'uint64', ullAvailPhys: 'uint64',
  ullTotalPageFile: 'uint64', ullAvailPageFile: 'uint64', ullTotalVirtual: 'uint64', ullAvailVirtual: 'uint64', ullAvailExtendedVirtual: 'uint64' })
koffi.struct('NOTCH_SYSTEM_POWER_STATUS', { ACLineStatus: 'uint8', BatteryFlag: 'uint8', BatteryLifePercent: 'uint8',
  SystemStatusFlag: 'uint8', BatteryLifeTime: 'uint32', BatteryFullLifeTime: 'uint32' })
koffi.struct('NOTCH_PROCESSENTRY32W', { dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', 260, 'String') })                                   // dwSize = koffi.sizeof(struct)
koffi.struct('NOTCH_PROCESS_MEMORY_COUNTERS_EX', { cb: 'uint32', PageFaultCount: 'uint32', PeakWorkingSetSize: 'size_t',
  WorkingSetSize: 'size_t', QuotaPeakPagedPoolUsage: 'size_t', QuotaPagedPoolUsage: 'size_t', QuotaPeakNonPagedPoolUsage: 'size_t',
  QuotaNonPagedPoolUsage: 'size_t', PagefileUsage: 'size_t', PeakPagefileUsage: 'size_t', PrivateUsage: 'size_t' })  // cb = sizeof
const PDH_VALUE = koffi.struct('NOTCH_PDH_FMT_COUNTERVALUE', { CStatus: 'uint32', doubleValue: 'double' })
const PDH_ITEM = koffi.struct('NOTCH_PDH_FMT_COUNTERVALUE_ITEM_W', { szName: 'str16', FmtValue: PDH_VALUE })

// kernel32
'bool __stdcall GetSystemTimes(_Out_ NOTCH_FILETIME *idle, _Out_ NOTCH_FILETIME *kernel, _Out_ NOTCH_FILETIME *user)'   // CPU% = 100*((Δkernel+Δuser)-Δidle)/(Δkernel+Δuser)
'bool __stdcall GlobalMemoryStatusEx(_Inout_ NOTCH_MEMORYSTATUSEX *s)'                                                  // pass { dwLength: sizeof }
'bool __stdcall GetSystemPowerStatus(_Out_ NOTCH_SYSTEM_POWER_STATUS *s)'
'uint32 __stdcall GetLogicalDrives()'
'uint32 __stdcall GetDriveTypeW(str16 root)'                                                                            // 3 = DRIVE_FIXED
'bool __stdcall GetDiskFreeSpaceExW(str16 dir, _Out_ uint64 *avail, _Out_ uint64 *total, _Out_ uint64 *free)'           // pass [0n] arrays
'void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'                                                   // flags 0x2
'bool __stdcall Process32FirstW(void *snap, _Inout_ NOTCH_PROCESSENTRY32W *e)'
'bool __stdcall Process32NextW(void *snap, _Inout_ NOTCH_PROCESSENTRY32W *e)'
'void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'                                                 // 0x1000 PQLI, 0x1 TERMINATE
'bool __stdcall CloseHandle(void *h)'
'bool __stdcall GetProcessTimes(void *h, _Out_ NOTCH_FILETIME *creation, _Out_ NOTCH_FILETIME *exit, _Out_ NOTCH_FILETIME *kernel, _Out_ NOTCH_FILETIME *user)'
'bool __stdcall K32GetProcessMemoryInfo(void *h, _Out_ NOTCH_PROCESS_MEMORY_COUNTERS_EX *c, uint32 cb)'
'bool __stdcall IsProcessCritical(void *h, _Out_ int *critical)'
'bool __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *session)'
'void * __stdcall GetCurrentProcess()'
'bool __stdcall TerminateProcess(void *h, uint32 code)'
// advapi32
'bool __stdcall OpenProcessToken(void *h, uint32 access, _Out_ void **token)'                                           // TOKEN_QUERY 0x8; token = [null]
'bool __stdcall GetTokenInformation(void *token, int cls, _Out_ uint8_t *buf, uint32 len, _Out_ uint32 *ret)'           // cls 1 = TokenUser; 1st call buf null, len 0 -> size
'bool __stdcall EqualSid(void *a, void *b)'                                                                             // sid = koffi.decode(buf, 'void *'); keep buf alive
// pdh
'uint32 __stdcall PdhOpenQueryW(str16 source, uintptr_t user, _Out_ void **query)'                                      // source null
'uint32 __stdcall PdhAddEnglishCounterW(void *query, str16 path, uintptr_t user, _Out_ void **counter)'
'uint32 __stdcall PdhCollectQueryData(void *query)'
'uint32 __stdcall PdhGetFormattedCounterValue(void *counter, uint32 fmt, _Out_ uint32 *type, _Out_ NOTCH_PDH_FMT_COUNTERVALUE *value)'  // fmt 0x200
'uint32 __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32 fmt, _Inout_ uint32 *bufSize, _Out_ uint32 *count, _Out_ uint8_t *buf)'
  // 1st call buf null -> PDH_MORE_DATA; then Buffer.alloc(size); koffi.decode(buf, koffi.array(PDH_ITEM, count))
'uint32 __stdcall PdhCloseQuery(void *query)'
```

Patrones útiles: parámetros de salida escalares se pasan como arrays de 1 elemento (`[0]`, `[0n]`, `[null]`); handles opacos como `void *` (null = fallo en `OpenProcess`); cerrar siempre con `CloseHandle` (token incluido) y `PdhCloseQuery`. Para el CPU por proceso, `GetProcessTimes` kernel+user en unidades de 100 ns: `%` = Δ / (Δt_ns/100 × núcleos) × 100; comparar `start` (creation FILETIME) entre muestras y antes de `TerminateProcess` para detectar PID reutilizado.
