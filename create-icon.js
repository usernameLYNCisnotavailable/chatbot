const { execSync } = require('child_process');
const fs = require('fs');

execSync(`powershell -Command "
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$bgColor = [System.Drawing.Color]::FromArgb(2, 4, 8)
$accentColor = [System.Drawing.Color]::FromArgb(0, 245, 196)
$graphics.Clear($bgColor)
$pen = New-Object System.Drawing.Pen $accentColor, 8
$graphics.DrawRectangle($pen, 20, 20, 216, 216)
$font = New-Object System.Drawing.Font 'Consolas', 72, [System.Drawing.FontStyle]::Bold
$brush = New-Object System.Drawing.SolidBrush $accentColor
$graphics.DrawString('CC', $font, $brush, 40, 80)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::OpenWrite('icon.ico')
$icon.Save($stream)
$stream.Close()
$graphics.Dispose()
$bitmap.Dispose()
Write-Host 'icon.ico saved'
"`);

console.log('Done');