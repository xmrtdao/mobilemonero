# Enrol through the LIVE service over real HTTP, from Windows PowerShell 5.1.
#
# Three separate client-side failures got in the way before, none server-side:
#   * curl 7.55 stalls on the multipart handshake here. It sends
#     `Expect: 100-continue`, uvicorn answers 100 Continue, the transfer never
#     completes, and curl reports HTTP 000 or a bare 100 with no body. That was
#     read as "the endpoint is broken" when it was never reached.
#   * `Invoke-WebRequest -Form` needs PowerShell 7; there is no pwsh here.
#   * Calling the ASGI app in-process writes .npy files the running service has
#     already loaded and will never see, and it needs the model loaded by hand
#     because lifespan never ran. That is how the gallery was left in a state
#     nobody could vouch for.
#
# So the script globs the dataset folder itself rather than taking paths on the
# command line. Passing -Paths through powershell.exe -File silently delivered an
# empty array - the script reported "no readable files given" while the photos
# were sitting right there - and a tool that can no-op while looking like it ran
# is worse than no tool. Globbing from a single -Pattern argument has one thing
# to go wrong and prints the files it matched so you can check them by eye.
#
# The multipart body is built by hand because 5.1 has no -Form. One part per
# photo, all named `files`, which is what the endpoint declares.
param(
  [Parameter(Mandatory = $true)][string]$Pattern,
  [string]$Name,
  [string]$Dataset = 'C:\Users\PureTrek\Desktop\Faces\Faces',
  [string]$Base = 'http://127.0.0.1:8090'
)

$ErrorActionPreference = 'Stop'

if (-not $Name) { $Name = $Pattern -replace '\*.*$', '' }

$files = @(Get-ChildItem -Path $Dataset -File |
           Where-Object { $_.Name -like $Pattern } | Sort-Object Name)

Write-Output "  pattern '$Pattern' -> $($files.Count) file(s) in $Dataset"
foreach ($f in $files) { Write-Output "    $($f.Name)  $($f.Length) bytes" }
if ($files.Count -eq 0) {
  Write-Output "  NOTHING MATCHED - stopping, refusing to report a vacuous success"
  exit 1
}

$boundary = '----graytech' + [guid]::NewGuid().ToString('N')
$enc = [System.Text.Encoding]::UTF8
$ms = New-Object System.IO.MemoryStream
foreach ($f in $files) {
  $head = @(
    "--$boundary",
    "Content-Disposition: form-data; name=`"files`"; filename=`"$($f.Name)`"",
    'Content-Type: image/jpeg',
    '', ''
  ) -join "`r`n"
  $b = $enc.GetBytes($head); $ms.Write($b, 0, $b.Length)
  $img = [System.IO.File]::ReadAllBytes($f.FullName); $ms.Write($img, 0, $img.Length)
  $crlf = $enc.GetBytes("`r`n"); $ms.Write($crlf, 0, $crlf.Length)
}
$t = $enc.GetBytes("--$boundary--`r`n"); $ms.Write($t, 0, $t.Length)
$body = $ms.ToArray(); $ms.Close()

Write-Output ""
Write-Output "  POST $Base/api/enrol?name=$Name   ($([math]::Round($body.Length/1KB,1)) KB)"

$url = "$Base/api/enrol?name=" + [uri]::EscapeDataString($Name)
$text = $null
try {
  $resp = Invoke-WebRequest -Uri $url -Method Post -Body $body `
    -ContentType "multipart/form-data; boundary=$boundary" -TimeoutSec 600
  $status = $resp.StatusCode; $text = $resp.Content
} catch {
  Write-Output "  REQUEST FAILED: $($_.Exception.Message)"
  if ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output "  body: $($sr.ReadToEnd())"
  }
  exit 1
}

Write-Output "  HTTP $status"
if (-not $text) { Write-Output "  (empty body)"; exit 1 }

$j = $text | ConvertFrom-Json
foreach ($k in @('ok','name','key','updated_existing','enrolled','spread',
                 'shot_quality','shot_note','reason','identities')) {
  if ($null -ne $j.$k) { Write-Output ("  {0,-17} {1}" -f $k, $j.$k) }
}
foreach ($x in @($j.rejected)) {
  if ($null -ne $x -and $x.file) { Write-Output "    REJECTED $($x.file): $($x.why)" }
}
foreach ($d in @($j.similar_to)) {
  if ($null -ne $d -and $d.name) { Write-Output "    similar_to $($d.name) @ $($d.cosine)" }
}
if ($j.ok -ne $true) { exit 1 }
exit 0
