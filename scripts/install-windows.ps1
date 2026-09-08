param(
    [string]$Destination = (Join-Path $env:USERPROFILE '.agents\skills')
)

& {
$ErrorActionPreference = 'Stop'
$installRoot = Join-Path $env:LOCALAPPDATA 'agent-stuff'
$archive = Join-Path ([System.IO.Path]::GetTempPath()) ('agent-stuff-' + [guid]::NewGuid() + '.zip')
try {
    Invoke-WebRequest 'https://codeload.github.com/zekurio/agent-stuff/zip/refs/heads/main' -OutFile $archive -UseBasicParsing
    Expand-Archive -LiteralPath $archive -DestinationPath $installRoot -Force
}
finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}
$skills = Get-ChildItem (Join-Path $installRoot 'agent-stuff-main\skills') -Directory
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

foreach ($skill in $skills) {
    $path = Join-Path $Destination $skill.Name
    $existing = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.LinkType -eq 'Junction' -and $existing.Target -eq $skill.FullName) {
            continue
        }
        throw "Refusing to replace existing skill: $path"
    }
    New-Item -ItemType Junction -Path $path -Target $skill.FullName | Out-Null
}

Write-Host "Skills installed at $Destination"
}
