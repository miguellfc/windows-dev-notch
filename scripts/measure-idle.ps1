<#
.SYNOPSIS
  Measures the idle cost of the running Developer Notch: the whole process tree
  (developer-notch.exe plus every descendant, the WebView2 msedgewebview2.exe processes included).

.DESCRIPTION
  Read-only. It never starts or stops the app, never reads its data folder or settings, and sends
  nothing anywhere: it only asks Windows for process ids, parent ids, names, memory counters and
  CPU times (Get-CimInstance Win32_Process and Get-Process).

  For each run it prints, per process, the private memory and the working set (MB), the totals of
  the tree, and the CPU of the whole tree as a percentage of one core over a 15 s window and a
  60 s window (deltas of the processes' CPU time). The whole measurement runs twice, with a pause
  between runs, and ends with a summary table.

  Works on Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER ProcessId
  The PID of developer-notch.exe to measure. By default it is found by its process name.

.PARAMETER PauseSeconds
  Pause between the two runs, in seconds (60 by default).

.PARAMETER ShortWindowSeconds
  The short CPU window, in seconds (15 by default).

.PARAMETER LongWindowSeconds
  The long CPU window, in seconds (60 by default).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\measure-idle.ps1
#>
[CmdletBinding()]
param(
    [int]$ProcessId = 0,
    [ValidateRange(0, 3600)][int]$PauseSeconds = 60,
    [ValidateRange(1, 3600)][int]$ShortWindowSeconds = 15,
    [ValidateRange(1, 3600)][int]$LongWindowSeconds = 60
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$AppName = 'developer-notch'
$MB = 1MB

function Find-Root {
    if ($ProcessId -gt 0) {
        $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (-not $p) { throw "No hay ningún proceso con el PID $ProcessId." }
        return $p.Id
    }
    $all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$AppName.exe'" -Property ProcessId, ParentProcessId)
    if ($all.Count -eq 0) { throw "Developer Notch no está en marcha (no se encontró $AppName.exe)." }
    $ids = @($all | ForEach-Object { [int]$_.ProcessId })
    # The root is the instance whose parent is not another developer-notch.exe.
    $roots = @($all | Where-Object { $ids -notcontains [int]$_.ParentProcessId })
    if ($roots.Count -ne 1) {
        $list = ($all | ForEach-Object { $_.ProcessId }) -join ', '
        throw "Hay varias instancias de $AppName.exe (PID $list). Indica cuál medir con -ProcessId."
    }
    return [int]$roots[0].ProcessId
}

# The root plus every descendant, by parent PID. A child must not be older than its parent, so a
# process whose parent PID was reused by the app is never counted.
function Get-TreeIds([int]$RootId) {
    $procs = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    $byId = @{}
    foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
    if (-not $byId.ContainsKey($RootId)) { throw "El proceso $RootId ya no está en marcha." }
    $children = @{}
    foreach ($p in $procs) {
        $parent = [int]$p.ParentProcessId
        if ($parent -eq [int]$p.ProcessId) { continue }
        if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }
        [void]$children[$parent].Add($p)
    }
    $tree = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($byId[$RootId])
    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        [void]$tree.Add([int]$node.ProcessId)
        $kids = $children[[int]$node.ProcessId]
        if (-not $kids) { continue }
        foreach ($kid in $kids) {
            if ($tree.Contains([int]$kid.ProcessId)) { continue }
            if ($node.CreationDate -and $kid.CreationDate -and $kid.CreationDate -lt $node.CreationDate) { continue }
            $queue.Enqueue($kid)
        }
    }
    return , $tree.ToArray()
}

function Get-TreeProcesses([int]$RootId) {
    $ids = Get-TreeIds $RootId
    return @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
}

# CPU seconds per PID (keyed by PID and start time, so a reused PID never matches).
function Get-CpuSnapshot([int]$RootId) {
    $snap = @{}
    foreach ($p in (Get-TreeProcesses $RootId)) {
        try {
            $key = '{0}|{1}' -f $p.Id, $p.StartTime.Ticks
            $snap[$key] = $p.TotalProcessorTime.TotalSeconds
        } catch {
            # The process exited between the listing and the read, or denies the query.
        }
    }
    return $snap
}

# CPU of the whole tree over a window, as a percentage of one core. A process that starts during
# the window counts from zero; one that exits during it is left out, so its CPU in the window is
# not counted.
function Measure-Cpu([int]$RootId, [int]$Seconds) {
    $before = Get-CpuSnapshot $RootId
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds $Seconds
    $after = Get-CpuSnapshot $RootId
    $elapsed = $clock.Elapsed.TotalSeconds
    $used = 0.0
    foreach ($key in $after.Keys) {
        $start = 0.0
        if ($before.ContainsKey($key)) { $start = $before[$key] }
        $used += [Math]::Max(0.0, $after[$key] - $start)
    }
    return 100.0 * $used / $elapsed
}

function Get-MemoryRows([int]$RootId) {
    $rows = foreach ($p in (Get-TreeProcesses $RootId)) {
        [pscustomobject]@{
            Proceso   = $p.ProcessName
            PID       = $p.Id
            PrivadaMB = [Math]::Round($p.PrivateMemorySize64 / $MB, 1)
            TrabajoMB = [Math]::Round($p.WorkingSet64 / $MB, 1)
        }
    }
    return @($rows | Sort-Object -Property PrivadaMB -Descending)
}

function Invoke-Run([int]$Number, [int]$RootId) {
    Write-Host ''
    Write-Host ("=== Medición {0} - {1:yyyy-MM-dd HH:mm:ss} ===" -f $Number, (Get-Date))
    $rows = Get-MemoryRows $RootId
    $rows | Format-Table -AutoSize @(
        @{ Label = 'Proceso'; Expression = { $_.Proceso } },
        @{ Label = 'PID'; Expression = { $_.PID }; Align = 'Right' },
        @{ Label = 'Memoria privada (MB)'; Expression = { '{0:N1}' -f $_.PrivadaMB }; Align = 'Right' },
        @{ Label = 'Conjunto de trabajo (MB)'; Expression = { '{0:N1}' -f $_.TrabajoMB }; Align = 'Right' }
    ) | Out-String -Width 200 | Write-Host
    $private = ($rows | Measure-Object -Property PrivadaMB -Sum).Sum
    $working = ($rows | Measure-Object -Property TrabajoMB -Sum).Sum
    Write-Host ("Total del árbol ({0} procesos): memoria privada {1:N1} MB, conjunto de trabajo {2:N1} MB" -f $rows.Count, $private, $working)
    Write-Host ("Midiendo la CPU durante {0} s..." -f $ShortWindowSeconds)
    $short = Measure-Cpu $RootId $ShortWindowSeconds
    Write-Host ("CPU en {0} s: {1:N2} % de un núcleo" -f $ShortWindowSeconds, $short)
    Write-Host ("Midiendo la CPU durante {0} s..." -f $LongWindowSeconds)
    $long = Measure-Cpu $RootId $LongWindowSeconds
    Write-Host ("CPU en {0} s: {1:N2} % de un núcleo" -f $LongWindowSeconds, $long)
    return [pscustomobject]@{
        Medicion  = $Number
        Procesos  = $rows.Count
        PrivadaMB = $private
        TrabajoMB = $working
        CpuCorta  = $short
        CpuLarga  = $long
    }
}

$root = Find-Root
$rootProcess = Get-Process -Id $root
Write-Host ("Developer Notch: PID {0}, en marcha desde {1:yyyy-MM-dd HH:mm:ss}" -f $root, $rootProcess.StartTime)
Write-Host ("Procesadores lógicos: {0}" -f [Environment]::ProcessorCount)

$results = @()
$results += Invoke-Run 1 $root
if ($PauseSeconds -gt 0) {
    Write-Host ''
    Write-Host ("Pausa de {0} s antes de la segunda medición..." -f $PauseSeconds)
    Start-Sleep -Seconds $PauseSeconds
}
$results += Invoke-Run 2 $root

Write-Host ''
Write-Host '=== Resumen ==='
$results | Format-Table -AutoSize @(
    @{ Label = 'Medición'; Expression = { $_.Medicion }; Align = 'Right' },
    @{ Label = 'Procesos'; Expression = { $_.Procesos }; Align = 'Right' },
    @{ Label = 'Memoria privada (MB)'; Expression = { '{0:N1}' -f $_.PrivadaMB }; Align = 'Right' },
    @{ Label = 'Conjunto de trabajo (MB)'; Expression = { '{0:N1}' -f $_.TrabajoMB }; Align = 'Right' },
    @{ Label = ('CPU {0} s (% núcleo)' -f $ShortWindowSeconds); Expression = { '{0:N2}' -f $_.CpuCorta }; Align = 'Right' },
    @{ Label = ('CPU {0} s (% núcleo)' -f $LongWindowSeconds); Expression = { '{0:N2}' -f $_.CpuLarga }; Align = 'Right' }
) | Out-String -Width 200 | Write-Host
Write-Host 'Objetivo: memoria privada del árbol de 230 MB o menos.'
