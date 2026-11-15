Add-Type -Namespace K -Name U -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte b,byte s,int f,int e);'
[K.U]::keybd_event(0x5B,0,0,0); [K.U]::keybd_event(0x4E,0,0,0); [K.U]::keybd_event(0x4E,0,2,0); [K.U]::keybd_event(0x5B,0,2,0)
