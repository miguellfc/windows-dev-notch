param([string]$c,[string]$prefix)
$clicks=$c.Split(",") | % {[int]$_}
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -Namespace K -Name U -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte b,byte s,int f,int e); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);'
function Shot($p){ $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save($p); $g.Dispose(); $bmp.Dispose() }
[K.U]::keybd_event(0x5B,0,0,0); [K.U]::keybd_event(0x4E,0,0,0); [K.U]::keybd_event(0x4E,0,2,0); [K.U]::keybd_event(0x5B,0,2,0); Start-Sleep 2
Shot "$prefix-0-open.png"
for($i=0;$i -lt $clicks.Count;$i+=2){ [K.U]::SetCursorPos($clicks[$i],$clicks[$i+1]); Start-Sleep -Milliseconds 500; [K.U]::mouse_event(2,0,0,0,0); [K.U]::mouse_event(4,0,0,0,0); Start-Sleep 1; Shot ("$prefix-{0}.png" -f ($i/2+1)) }
