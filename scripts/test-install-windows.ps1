$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('agent-stuff-' + [guid]::NewGuid())
$destination = Join-Path $testRoot 'links'
$previousLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path $testRoot 'appdata'
try {
    $fixture = New-Item -ItemType Directory -Path "$testRoot\fixture\agent-stuff-main" -Force
    Copy-Item "$PSScriptRoot\..\skills" $fixture.FullName -Recurse
    Compress-Archive "$testRoot\fixture\agent-stuff-main" "$testRoot\fixture.zip"
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing)
        Copy-Item "$testRoot\fixture.zip" $OutFile
    }
    # Exercise the same text evaluation used by irm | iex, without network access.
    $installer = Get-Content "$PSScriptRoot\install-windows.ps1" -Raw
    & ([scriptblock]::Create($installer)) -Destination $destination
    & ([scriptblock]::Create($installer)) -Destination $destination
    foreach ($skill in Get-ChildItem "$env:LOCALAPPDATA\agent-stuff\agent-stuff-main\skills" -Directory) {
        $link = Get-Item -LiteralPath (Join-Path $destination $skill.Name)
        if ($link.LinkType -ne 'Junction' -or $link.Target -ne $skill.FullName -or
            !(Test-Path (Join-Path $link.FullName 'SKILL.md'))) {
            throw "Missing or incorrect skill junction: $($skill.Name)"
        }
    }
    $conflict = Join-Path $destination $skill.Name
    [System.IO.Directory]::Delete($conflict)
    New-Item -ItemType Directory -Path $conflict | Out-Null
    Set-Content (Join-Path $conflict 'keep.txt') 'keep'
    $rejected = $false
    try { & "$PSScriptRoot\install-windows.ps1" -Destination $destination }
    catch {
        if ($_.Exception.Message -notlike 'Refusing to replace existing skill:*') { throw }
        $rejected = $true
    }
    if (!$rejected -or (Get-Content (Join-Path $conflict 'keep.txt')) -ne 'keep') {
        throw 'Existing skill was not protected'
    }
    Write-Host 'Windows installation checks passed'
}
finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    if (Test-Path -LiteralPath $destination) {
        Get-ChildItem -LiteralPath $destination | Where-Object LinkType -eq 'Junction' |
            ForEach-Object { [System.IO.Directory]::Delete($_.FullName) }
    }
    if ($testRoot -and (Split-Path $testRoot -Parent) -eq [System.IO.Path]::GetTempPath().TrimEnd('\')) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
