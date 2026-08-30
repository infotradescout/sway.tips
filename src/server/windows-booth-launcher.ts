import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WindowsBoothLauncher = {
  filename: string;
  contentType: 'application/x-msdos-program';
  contentBase64: string;
  sha256: string;
  expiresAt: string;
};

function powershellLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeSwayOrigin(value: string) {
  const parsed = new URL(value);
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('Sway Booth requires HTTPS outside local development.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('Sway Booth received an invalid Sway origin.');
  }
  return parsed.origin;
}

function normalizeExpiresAt(value: string | Date) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Sway Booth requires a valid expiration time.');
  return parsed.toISOString();
}

function validateInput(input: {
  swayUrl: string;
  gigId: string;
  bridgeToken: string;
  expiresAt: string | Date;
}) {
  const swayUrl = normalizeSwayOrigin(input.swayUrl);
  const gigId = String(input.gigId || '').trim();
  const bridgeToken = String(input.bridgeToken || '').trim();
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const expiresAtMs = Date.parse(expiresAt);
  const now = Date.now();
  if (!UUID_PATTERN.test(gigId)) throw new Error('Sway Booth requires a valid live-room id.');
  if (bridgeToken.length < 20 || bridgeToken.length > 1_024 || /[\r\n]/.test(bridgeToken)) {
    throw new Error('Sway Booth requires a valid room-scoped token.');
  }
  if (expiresAtMs <= now || expiresAtMs > now + (7 * 60 * 60 * 1_000)) {
    throw new Error('Sway Booth requires a short-lived room connection.');
  }
  return { swayUrl, gigId, bridgeToken, expiresAt };
}

function buildPowerShellBody(input: ReturnType<typeof validateInput>) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$SwayUrl = ${powershellLiteral(input.swayUrl)}
$GigId = ${powershellLiteral(input.gigId)}
$AuthToken = ${powershellLiteral(input.bridgeToken)}
$ExpiresAt = [DateTimeOffset]::Parse(${powershellLiteral(input.expiresAt)})
$SourceKey = 'virtualdj'
$BridgeInstanceId = [Guid]::NewGuid().ToString()
$createdNew = $false
$BoothMutex = [System.Threading.Mutex]::new($true, "Local\SwayBooth-$GigId", [ref]$createdNew)
if (-not $createdNew) {
  Write-Host 'Sway Booth is already open for this room.' -ForegroundColor Yellow
  exit 0
}

function Write-SwayHeading([string]$Text) {
  Write-Host ''
  Write-Host $Text -ForegroundColor Cyan
}

function Read-Default([string]$Prompt, [string]$DefaultValue) {
  $answer = Read-Host "$Prompt [$DefaultValue]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $DefaultValue }
  return $answer.Trim()
}

function ConvertTo-VirtualDjText([object]$Value) {
  if ($null -eq $Value) { return '' }
  $text = [string]$Value
  $text = $text.Replace('\', '\\').Replace('"', '\"')
  $text = $text.Replace([char]13, ' ').Replace([char]10, ' ')
  if ($text.Length -gt 2048) { return $text.Substring(0, 2048) }
  return $text
}

function Test-SwayTrue([object]$Value) {
  return ([string]$Value).Trim() -match '^(true|yes|on|1)$'
}

function Invoke-SwayRequest([string]$Route, [string]$Method = 'GET', [object]$Body = $null) {
  $headers = @{ Authorization = "Bearer $AuthToken"; Accept = 'application/json' }
  $parameters = @{
    Uri = "$SwayUrl$Route"
    Method = $Method
    Headers = $headers
    TimeoutSec = 12
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json; charset=utf-8'
    $parameters.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
  }
  $response = Invoke-WebRequest @parameters
  if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
  return $response.Content | ConvertFrom-Json
}

function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) {
  $headers = @{}
  if (-not [string]::IsNullOrWhiteSpace($VirtualDjPassword)) {
    $headers.Authorization = "Bearer $VirtualDjPassword"
  }
  $parameters = @{
    Uri = "$VirtualDjUrl/$Endpoint"
    Method = 'POST'
    Headers = $headers
    ContentType = 'text/plain; charset=utf-8'
    Body = $Script
    TimeoutSec = 5
    UseBasicParsing = $true
  }
  $response = Invoke-WebRequest @parameters
  return ([string]$response.Content).Trim()
}

function Invoke-VirtualDjExecute([string]$Script) {
  $result = Invoke-VirtualDjRequest 'execute' $Script
  if (-not (Test-SwayTrue $result)) {
    throw "VirtualDJ rejected: $Script"
  }
  return $result
}

function Invoke-VirtualDjCommand([object]$Command) {
  $payload = $Command.payload
  $targetDeck = $Deck
  if ($null -ne $payload -and $null -ne $payload.deck) {
    $candidateDeck = 0
    if ([int]::TryParse([string]$payload.deck, [ref]$candidateDeck) -and $candidateDeck -ge 1 -and $candidateDeck -le 8) {
      $targetDeck = $candidateDeck
    }
  }

  $script = $null
  $loadMatchMode = $null
  switch ([string]$Command.action) {
    'load' {
      $track = $payload.track
      $path = if ($null -ne $track) { [string]$track.path } else { '' }
      if (-not [string]::IsNullOrWhiteSpace($path)) {
        $script = 'deck ' + $targetDeck + ' load "' + (ConvertTo-VirtualDjText $path) + '"'
        $loadMatchMode = 'exact_library_path'
      } else {
        $artist = if ($null -ne $track) { [string]$track.artist } else { '' }
        $title = if ($null -ne $track) { [string]$track.title } else { '' }
        $query = "$artist $title".Trim()
        if ([string]::IsNullOrWhiteSpace($query)) { throw 'This request has no playable path or searchable title.' }
        $script = 'search "' + (ConvertTo-VirtualDjText $query) + '" & browser_scroll "top" & deck ' + $targetDeck + ' load'
        $loadMatchMode = 'virtualdj_search_first_result'
      }
    }
    'play' { $script = "deck $targetDeck play on" }
    'pause' { $script = "deck $targetDeck pause" }
    'stop' { $script = "deck $targetDeck stop" }
    'cue' { $script = "deck $targetDeck cue_stop" }
    'next' { $script = "deck $targetDeck load_next" }
    'previous' { $script = "deck $targetDeck load_previous" }
    default { throw "Unsupported playback action: $($Command.action)" }
  }

  [void](Invoke-VirtualDjExecute $script)
  return @{
    executed = $true
    deck = $targetDeck
    action = [string]$Command.action
    script = $script
    loadMatchMode = $loadMatchMode
  }
}

function Read-VirtualDjState {
  $title = Invoke-VirtualDjRequest 'query' "deck $Deck get_title"
  $artist = Invoke-VirtualDjRequest 'query' "deck $Deck get_artist"
  $filePath = Invoke-VirtualDjRequest 'query' "deck $Deck get_filepath"
  $playing = Invoke-VirtualDjRequest 'query' "deck $Deck play"
  $position = Invoke-VirtualDjRequest 'query' "deck $Deck get_position"
  $bpmText = Invoke-VirtualDjRequest 'query' "deck $Deck get_bpm"
  $bpm = 0.0
  $bpmTimes100 = $null
  if ([double]::TryParse($bpmText, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$bpm)) {
    $bpmTimes100 = [Math]::Max(0, [Math]::Round($bpm * 100))
  }
  return @{
    sourceKey = $SourceKey
    transport = 'virtualdj_network_control_http_windows_companion'
    bridgeInstanceId = $BridgeInstanceId
    connectionStatus = 'connected'
    deck = $Deck
    trackTitle = if ([string]::IsNullOrWhiteSpace($title)) { $null } else { $title }
    trackArtist = if ([string]::IsNullOrWhiteSpace($artist)) { $null } else { $artist }
    trackPath = if ([string]::IsNullOrWhiteSpace($filePath)) { $null } else { $filePath }
    playing = Test-SwayTrue $playing
    positionMs = $null
    durationMs = $null
    bpmTimes100 = $bpmTimes100
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
    metadata = @{ positionRatio = $position; networkControlUrl = $VirtualDjUrl; launcher = 'windows_cmd_v1' }
  }
}

function ConvertTo-LedgerTable([object]$Value) {
  $table = @{}
  if ($null -eq $Value) { return $table }
  foreach ($property in $Value.PSObject.Properties) { $table[$property.Name] = $property.Value }
  return $table
}

function Save-Ledger {
  $entries = @($Ledger.GetEnumerator() | Sort-Object { [string]$_.Value.completedAt } -Descending | Select-Object -First 250)
  $bounded = @{}
  foreach ($entry in $entries) { $bounded[[string]$entry.Key] = $entry.Value }
  $script:Ledger = $bounded
  $temporaryPath = "$LedgerPath.tmp"
  ($Ledger | ConvertTo-Json -Depth 12 -Compress) | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $LedgerPath -Force
}

function Complete-SwayCommand([string]$CommandId, [object]$Entry) {
  $body = @{
    gig_id = $GigId
    sourceKey = $SourceKey
    bridgeInstanceId = $BridgeInstanceId
    commandId = $CommandId
    success = [bool]$Entry.success
    result = $Entry.result
    error = $Entry.error
  }
  [void](Invoke-SwayRequest '/api/talent/playback/bridge/complete' 'POST' $body)
}

Clear-Host
Write-Host 'SWAY BOOTH' -ForegroundColor Magenta
Write-SwayHeading 'VirtualDJ connection'
Write-Host 'In VirtualDJ: Settings > Extensions > Effects > Other > Network Control.' -ForegroundColor Gray
Write-Host 'Install it, turn on Auto-Start, and use the same port/password below.' -ForegroundColor Gray

$portText = Read-Default 'Network Control port' '8088'
$port = 0
if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
  throw 'The Network Control port must be between 1 and 65535.'
}
$deckText = Read-Default 'Deck Sway should control' '1'
$Deck = 0
if (-not [int]::TryParse($deckText, [ref]$Deck) -or $Deck -lt 1 -or $Deck -gt 8) {
  throw 'The deck must be between 1 and 8.'
}
$securePassword = Read-Host 'Network Control password (press Enter if you did not set one)' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $VirtualDjPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
$VirtualDjUrl = "http://127.0.0.1:$port"

Write-SwayHeading 'Checking VirtualDJ'
try {
  $clock = Invoke-VirtualDjRequest 'query' 'get_clock'
  Write-Host "VirtualDJ answered at $VirtualDjUrl." -ForegroundColor Green
} catch {
  Write-Host 'Sway could not reach VirtualDJ Network Control on this computer.' -ForegroundColor Red
  Write-Host 'Check that the extension is installed, Auto-Start is on, and the port/password match.' -ForegroundColor Yellow
  throw
}

$ledgerDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Sway'
[void](New-Item -ItemType Directory -Path $ledgerDirectory -Force)
$LedgerPath = Join-Path $ledgerDirectory "booth-ledger-$GigId.json"
$Ledger = @{}
if (Test-Path -LiteralPath $LedgerPath) {
  try { $Ledger = ConvertTo-LedgerTable ((Get-Content -LiteralPath $LedgerPath -Raw) | ConvertFrom-Json) } catch { $Ledger = @{} }
}

Write-SwayHeading 'Connected'
Write-Host 'Leave this window open during the room. Sway now controls VirtualDJ.' -ForegroundColor Green
Write-Host 'Press Ctrl+C to disconnect.' -ForegroundColor DarkGray
$nextStateAt = [DateTimeOffset]::MinValue
$lastCloudWarning = $null

while ([DateTimeOffset]::UtcNow -lt $ExpiresAt) {
  try {
    $claim = Invoke-SwayRequest '/api/talent/playback/bridge/claim' 'POST' @{
      gig_id = $GigId
      sourceKey = $SourceKey
      bridgeInstanceId = $BridgeInstanceId
    }
    foreach ($command in @($claim.commands)) {
      $commandId = [string]$command.id
      if ([string]::IsNullOrWhiteSpace($commandId)) { continue }
      $entry = $Ledger[$commandId]
      if ($null -eq $entry) {
        try {
          $result = Invoke-VirtualDjCommand $command
          $entry = @{ success = $true; result = $result; error = $null; completedAt = [DateTimeOffset]::UtcNow.ToString('o') }
          Write-Host "Confirmed $($command.action) on deck $($result.deck)." -ForegroundColor Green
        } catch {
          $message = $_.Exception.Message
          if ($message.Length -gt 1000) { $message = $message.Substring(0, 1000) }
          $entry = @{ success = $false; result = @{}; error = $message; completedAt = [DateTimeOffset]::UtcNow.ToString('o') }
          Write-Host "VirtualDJ could not run $($command.action): $message" -ForegroundColor Red
        }
        $Ledger[$commandId] = $entry
        Save-Ledger
      }
      try { Complete-SwayCommand $commandId $entry } catch { Write-Host 'Command result will retry.' -ForegroundColor Yellow }
    }

    if ([DateTimeOffset]::UtcNow -ge $nextStateAt) {
      $state = Read-VirtualDjState
      [void](Invoke-SwayRequest '/api/talent/playback/bridge/state' 'POST' @{ gig_id = $GigId; state = $state })
      $nextStateAt = [DateTimeOffset]::UtcNow.AddSeconds(2)
    }
    $lastCloudWarning = $null
  } catch {
    $message = $_.Exception.Message
    if ($message -ne $lastCloudWarning) {
      Write-Host "Sway connection is retrying: $message" -ForegroundColor Yellow
      $lastCloudWarning = $message
    }
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Milliseconds 750
}

Write-Host 'This room connection expired. Download a fresh Sway Booth file from Connections.' -ForegroundColor Yellow
`.trimStart();
}

export function buildWindowsBoothLauncher(input: {
  swayUrl: string;
  gigId: string;
  bridgeToken: string;
  expiresAt: string | Date;
}): WindowsBoothLauncher {
  const normalized = validateInput(input);
  const powerShellBody = buildPowerShellBody(normalized).replace(/\r?\n/g, '\r\n');
  const launcherContent = [
    '@echo off',
    'setlocal',
    'title Sway Booth',
    'set "SWAY_BOOTH_FILE=%~f0"',
    'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines=Get-Content -LiteralPath $env:SWAY_BOOTH_FILE; $marker=[Array]::IndexOf($lines,\'# SWAY_BOOTH_POWERSHELL\'); if($marker -lt 0){throw \'Sway Booth launcher is incomplete.\'}; $body=$lines[($marker+1)..($lines.Length-1)] -join [Environment]::NewLine; & ([ScriptBlock]::Create($body))"',
    'set "SWAY_BOOTH_EXIT=%ERRORLEVEL%"',
    'if not "%SWAY_BOOTH_EXIT%"=="0" pause',
    'exit /b %SWAY_BOOTH_EXIT%',
    '# SWAY_BOOTH_POWERSHELL',
    powerShellBody
  ].join('\r\n');
  const content = Buffer.from(launcherContent, 'utf8');
  return {
    filename: `sway-booth-${normalized.gigId.slice(0, 8)}.cmd`,
    contentType: 'application/x-msdos-program',
    contentBase64: content.toString('base64'),
    sha256: createHash('sha256').update(content).digest('hex'),
    expiresAt: normalized.expiresAt
  };
}
