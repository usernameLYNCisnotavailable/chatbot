Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap(256,256)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::FromArgb(2,4,8))
$p = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0,245,196),8)
$g.DrawRectangle($p,20,20,216,216)
$f = New-Object System.Drawing.Font("Consolas",80,[System.Drawing.FontStyle]::Bold)
$br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0,245,196))
$g.DrawString("CC",$f,$br,30,70)
$b.Save("icon.png",[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$b.Dispose()
Write-Host "done"
$bytes = [System.IO.File]::ReadAllBytes("icon.png")
[System.IO.File]::WriteAllBytes("icon.ico", $bytes)
Write-Host "ico saved"