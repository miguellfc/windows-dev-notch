Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -Namespace K -Name U -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte b,byte s,int f,int e);'
[K.U]::keybd_event(0x5B,0,0,0); [K.U]::keybd_event(0x4E,0,0,0); [K.U]::keybd_event(0x4E,0,2,0); [K.U]::keybd_event(0x5B,0,2,0)
Start-Sleep 2
$root=[System.Windows.Automation.AutomationElement]::RootElement
foreach($nm in 'Posponer','Completar','V2 spike','Notifications','Notification Center','Notification'){
  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$nm)
  $r=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c)
  Write-Output "$nm -> $($r.Count)"
  foreach($e in $r){ Write-Output ("   {0} class={1} rect={2}" -f $e.Current.ControlType.ProgrammaticName,$e.Current.ClassName,$e.Current.BoundingRectangle) }
}
