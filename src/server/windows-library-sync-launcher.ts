import { createHash } from 'node:crypto';

export type WindowsLibrarySyncLauncher = {
  filename: string;
  contentType: 'application/x-msdos-program';
  contentBase64: string;
  sha256: string;
};

function powershellLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeSwayOrigin(value: string) {
  const parsed = new URL(value);
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('Sway Music Helper requires HTTPS outside local development.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('Sway Music Helper received an invalid Sway origin.');
  }
  return parsed.origin;
}

function validateInput(input: { swayUrl: string; sourceKey: string; syncKey: string }) {
  const swayUrl = normalizeSwayOrigin(input.swayUrl);
  const sourceKey = String(input.sourceKey || '').trim();
  const syncKey = String(input.syncKey || '').trim();
  if (!/^[a-z0-9_-]{1,64}$/.test(sourceKey)) throw new Error('Sway Music Helper requires a valid source id.');
  if (!/^sway_lib_[a-f0-9]{48}$/.test(syncKey)) throw new Error('Sway Music Helper requires a valid private sync key.');
  return { swayUrl, sourceKey, syncKey };
}

function buildPowerShellBody(input: ReturnType<typeof validateInput>) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$SwayUrl = ${powershellLiteral(input.swayUrl)}
$SyncKey = ${powershellLiteral(input.syncKey)}
trap {
  Write-Host ''
  Write-Host "COULDN'T UPDATE YOUR MUSIC" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  Write-Host 'Nothing was removed. Check your connection or make a fresh helper in Sway.' -ForegroundColor Gray
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

Clear-Host
Write-Host 'SWAY MUSIC HELPER' -ForegroundColor Magenta
Write-Host ''
Write-Host 'Choose your latest DJ library export.' -ForegroundColor Cyan
Write-Host 'Your audio files stay on this computer. Sway receives only the request list.' -ForegroundColor Gray

Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.OpenFileDialog
$picker.Title = 'Choose your DJ library export'
$picker.Filter = 'DJ library exports (*.xml;*.nml;*.m3u;*.m3u8;*.csv)|*.xml;*.nml;*.m3u;*.m3u8;*.csv|All supported files (*.*)|*.*'
$picker.Multiselect = $false
if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
  Write-Host 'Nothing changed. You can close this window.' -ForegroundColor Yellow
  exit 0
}

$selectedFile = $picker.FileName
$fileInfo = Get-Item -LiteralPath $selectedFile
if ($fileInfo.Length -gt 10000000) {
  throw 'That export is larger than 10 MB. Export a smaller playlist or use the command-line bridge under Technical details.'
}

Write-Host ''
Write-Host 'Updating your saved music...' -ForegroundColor Cyan
$headers = @{
  'x-sway-library-key' = $SyncKey
  'x-sway-library-filename' = [IO.Path]::GetFileName($selectedFile)
  Accept = 'application/json'
}
$content = [IO.File]::ReadAllText($selectedFile)
$response = Invoke-WebRequest -Uri "$SwayUrl/api/library/import-file" -Method Post -Headers $headers -ContentType 'text/plain; charset=utf-8' -Body $content -TimeoutSec 60 -UseBasicParsing
$result = if ([string]::IsNullOrWhiteSpace($response.Content)) { $null } else { $response.Content | ConvertFrom-Json }
$count = if ($null -ne $result -and $null -ne $result.importedCount) { [int]$result.importedCount } else { 0 }
$trackReady = if ($count -eq 1) { 'track is' } else { 'tracks are' }

Write-Host ''
Write-Host "DONE - $count $trackReady ready in every room." -ForegroundColor Green
Write-Host 'Keep this helper. Double-click it again after your DJ library changes.' -ForegroundColor Gray
Write-Host ''
Read-Host 'Press Enter to close'
`.trimStart();
}

export function buildWindowsLibrarySyncLauncher(input: {
  swayUrl: string;
  sourceKey: string;
  syncKey: string;
}): WindowsLibrarySyncLauncher {
  const normalized = validateInput(input);
  const powerShellBody = buildPowerShellBody(normalized).replace(/\r?\n/g, '\r\n');
  const launcherContent = [
    '@echo off',
    'setlocal',
    'title Sway Music Helper',
    'set "SWAY_MUSIC_HELPER_FILE=%~f0"',
    'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines=Get-Content -LiteralPath $env:SWAY_MUSIC_HELPER_FILE; $marker=[Array]::IndexOf($lines,\'# SWAY_MUSIC_HELPER_POWERSHELL\'); if($marker -lt 0){throw \'Sway Music Helper is incomplete.\'}; $body=$lines[($marker+1)..($lines.Length-1)] -join [Environment]::NewLine; & ([ScriptBlock]::Create($body))"',
    'set "SWAY_MUSIC_HELPER_EXIT=%ERRORLEVEL%"',
    'if not "%SWAY_MUSIC_HELPER_EXIT%"=="0" pause',
    'exit /b %SWAY_MUSIC_HELPER_EXIT%',
    '# SWAY_MUSIC_HELPER_POWERSHELL',
    powerShellBody
  ].join('\r\n');
  const content = Buffer.from(launcherContent, 'utf8');
  return {
    filename: `sway-music-${normalized.sourceKey.slice(0, 32)}.cmd`,
    contentType: 'application/x-msdos-program',
    contentBase64: content.toString('base64'),
    sha256: createHash('sha256').update(content).digest('hex')
  };
}
