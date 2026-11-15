Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$tops=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
foreach($t in $tops){ try{ $n=$t.Current.Name; $c=$t.Current.ClassName; if($c -like '*CoreWindow*' -or $n -like '*otif*'){ Write-Output "TOP: [$n] [$c]"
 $d=$t.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
 foreach($e in $d){ try{ Write-Output ("   {0} | {1}" -f $e.Current.ControlType.ProgrammaticName.Replace('ControlType.',''),$e.Current.Name) }catch{} } } }catch{} }
