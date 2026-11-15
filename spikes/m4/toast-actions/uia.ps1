param([string]$name,[string]$mode='invoke')
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$hits=@()
foreach($e in $all){ try{ $n=$e.Current.Name; if($n -like "*$name*" -or $n -like '*spike*'){ $hits+=$e; Write-Output ("{0} | {1} | {2}" -f $e.Current.ControlType.ProgrammaticName,$n,$e.Current.ClassName) } }catch{} }
if($mode -eq 'invoke'){ foreach($e in $hits){ if($e.Current.Name -eq $name){ try{ $p=$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); Write-Output "INVOKED $name"; break }catch{ Write-Output "invoke failed: $_" } } } }
