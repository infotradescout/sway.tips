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
  const authGeneration = createHash('sha256').update(input.bridgeToken, 'utf8').digest('hex');
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$SwayUrl = ${powershellLiteral(input.swayUrl)}
$GigId = ${powershellLiteral(input.gigId)}
$AuthToken = ${powershellLiteral(input.bridgeToken)}
$AuthGeneration = ${powershellLiteral(authGeneration)}
$ExpiresAt = [DateTimeOffset]::Parse(${powershellLiteral(input.expiresAt)})
$SourceKey = 'virtualdj'
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

function ConvertFrom-VirtualDjPlaying([object]$Value) {
  $text = ([string]$Value).Trim()
  if ($text -match '^(true|yes|on|1)$') { return $true }
  if ($text -match '^(false|no|off|0)$') { return $false }
  throw 'VirtualDJ returned an unreadable playback state.'
}

function ConvertTo-ComparableText([object]$Value) {
  if ($null -eq $Value) { return '' }
  return (([string]$Value).Normalize([Text.NormalizationForm]::FormKC).Trim().ToLowerInvariant() -replace '\s+', ' ')
}

function ConvertTo-ComparablePath([object]$Value) {
  if ($null -eq $Value) { return '' }
  return ([string]$Value).Replace('\', '/')
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
  try {
    $response = Invoke-WebRequest @parameters
  } catch {
    if ($Endpoint -eq 'execute') {
      if ($null -ne $_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        throw "VirtualDJ rejected the command (HTTP $statusCode)."
      }
      throw 'VirtualDJ response was lost; command outcome is uncertain. Check the selected deck before retrying.'
    }
    throw 'VirtualDJ state request failed.'
  }
  return ([string]$response.Content).Trim()
}

function Invoke-VirtualDjExecute([string]$Script) {
  $result = Invoke-VirtualDjRequest 'execute' $Script
  if ($result -cne 'true') {
    throw 'VirtualDJ rejected the command.'
  }
  return $result
}

function Resolve-TargetDeck([object]$Command) {
  $payload = $Command.payload
  $targetDeck = $Deck
  if ($null -ne $payload -and $null -ne $payload.deck) {
    $candidateDeck = 0
    if ([int]::TryParse([string]$payload.deck, [ref]$candidateDeck) -and $candidateDeck -ge 1 -and $candidateDeck -le 8) {
      $targetDeck = $candidateDeck
    }
  }
  return $targetDeck
}

function Invoke-VirtualDjCommand([object]$Command) {
  $payload = $Command.payload
  $targetDeck = Resolve-TargetDeck $Command

  $script = $null
  $loadMatchMode = $null
  $track = $null
  switch ([string]$Command.action) {
    'load' {
      $track = $payload.track
      $path = if ($null -ne $track) { [string]$track.path } else { '' }
      if (-not [string]::IsNullOrWhiteSpace($path)) {
        $script = 'deck ' + $targetDeck + ' load "' + (ConvertTo-VirtualDjText $path) + '"'
        $loadMatchMode = 'exact_library_path'
      } else {
        throw 'VirtualDJ automatic load requires an exact synced booth path. Load this track manually.'
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

  $commandExpiresAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Command.expiresAt, [ref]$commandExpiresAt) -or
      [DateTimeOffset]::UtcNow -ge $commandExpiresAt) {
    throw 'Playback command expired or has an invalid deadline. Send a fresh command.'
  }
  [void](Invoke-VirtualDjExecute $script)
  Start-Sleep -Milliseconds 150
  $state = $null
  try { $state = Read-VirtualDjState $targetDeck } catch { $state = $null }
  $confirmationStatus = 'source_acknowledged'
  if ($null -ne $state -and [string]$Command.action -eq 'load') {
    $requestedPath = if ($null -ne $track) { ConvertTo-ComparablePath $track.path } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($requestedPath) -and $requestedPath -ceq (ConvertTo-ComparablePath $state.trackPath)) {
      $confirmationStatus = 'exact_track_confirmed'
    }
  } elseif ($null -ne $state -and [string]$Command.action -eq 'play' -and [bool]$state.playing) {
    $confirmationStatus = 'source_state_confirmed'
  } elseif ($null -ne $state -and [string]$Command.action -eq 'pause' -and -not [bool]$state.playing) {
    $confirmationStatus = 'source_state_confirmed'
  }
  return @{
    result = @{
      acknowledgement = 'accepted'
      deck = $targetDeck
      action = [string]$Command.action
      loadMatchMode = $loadMatchMode
      confirmationStatus = $confirmationStatus
      observedAt = if ($null -ne $state) { $state.observedAt } else { $null }
      observedDeck = if ($null -ne $state) { $state.deck } else { $targetDeck }
      observedTrackTitle = if ($null -ne $state) { $state.trackTitle } else { $null }
      observedTrackArtist = if ($null -ne $state) { $state.trackArtist } else { $null }
      observedPlaying = if ($null -ne $state) { $state.playing } else { $null }
    }
    state = $state
  }
}

function Read-VirtualDjState([int]$TargetDeck = $Deck) {
  $title = Invoke-VirtualDjRequest 'query' "deck $TargetDeck get_title"
  $artist = Invoke-VirtualDjRequest 'query' "deck $TargetDeck get_artist"
  $filePath = Invoke-VirtualDjRequest 'query' "deck $TargetDeck get_filepath"
  $playing = Invoke-VirtualDjRequest 'query' "deck $TargetDeck play"
  $playingValue = ConvertFrom-VirtualDjPlaying $playing
  $position = Invoke-VirtualDjRequest 'query' "deck $TargetDeck get_position"
  $bpmText = Invoke-VirtualDjRequest 'query' "deck $TargetDeck get_bpm"
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
    deck = $TargetDeck
    trackTitle = if ([string]::IsNullOrWhiteSpace($title)) { $null } else { $title }
    trackArtist = if ([string]::IsNullOrWhiteSpace($artist)) { $null } else { $artist }
    trackPath = if ([string]::IsNullOrWhiteSpace($filePath)) { $null } else { $filePath }
    playing = $playingValue
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
  $document = @{
    version = 2
    authGeneration = $AuthGeneration
    bridgeInstanceId = $BridgeInstanceId
    targetDeck = $Deck
    outcomes = $Ledger
    pendingCompletionIds = @($PendingCompletionIds)
  }
  ($document | ConvertTo-Json -Depth 12 -Compress) | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
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
  $receipt = Invoke-SwayRequest '/api/talent/playback/bridge/complete' 'POST' $body
  $expectedStatus = if ([bool]$Entry.success) { 'succeeded' } else { 'failed' }
  if ($null -eq $receipt -or $receipt.success -isnot [bool] -or -not $receipt.success -or
      $null -eq $receipt.command -or [string]$receipt.command.id -cne $CommandId -or
      [string]$receipt.command.gigId -cne $GigId -or [string]$receipt.command.sourceKey -cne $SourceKey -or
      [string]$receipt.command.status -cne $expectedStatus) {
    throw 'Sway has not confirmed this command result. Completion will retry.'
  }
}

function Flush-PendingCompletions {
  foreach ($commandId in @($PendingCompletionIds)) {
    $entry = $Ledger[[string]$commandId]
    if ($null -eq $entry) {
      $script:PendingCompletionIds = @($PendingCompletionIds | Where-Object { $_ -ne $commandId })
      Save-Ledger
      continue
    }
    try {
      Complete-SwayCommand ([string]$commandId) $entry
      $script:PendingCompletionIds = @($PendingCompletionIds | Where-Object { $_ -ne $commandId })
      Save-Ledger
    } catch {
      Write-Host 'Command result will retry before another claim.' -ForegroundColor Yellow
      break
    }
  }
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

$ledgerDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Sway'
[void](New-Item -ItemType Directory -Path $ledgerDirectory -Force)
$LedgerPath = Join-Path $ledgerDirectory "booth-ledger-$GigId.json"
$BridgeInstanceId = [Guid]::NewGuid().ToString()
$Ledger = @{}
$PendingCompletionIds = @()
if (Test-Path -LiteralPath $LedgerPath) {
  try {
    $savedLedger = (Get-Content -LiteralPath $LedgerPath -Raw) | ConvertFrom-Json
    if ([int]$savedLedger.version -eq 2 -and [string]$savedLedger.authGeneration -eq $AuthGeneration) {
      $savedBridgeId = [string]$savedLedger.bridgeInstanceId
      $parsedBridgeId = [Guid]::Empty
      if ([Guid]::TryParse($savedBridgeId, [ref]$parsedBridgeId)) { $BridgeInstanceId = $savedBridgeId }
      $Ledger = ConvertTo-LedgerTable $savedLedger.outcomes
      $PendingCompletionIds = @($savedLedger.pendingCompletionIds | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      $savedTargetDeck = 0
      if ([int]::TryParse([string]$savedLedger.targetDeck, [ref]$savedTargetDeck) -and $savedTargetDeck -ge 1 -and $savedTargetDeck -le 8) {
        $Deck = $savedTargetDeck
      }
    }
  } catch {
    $Ledger = @{}
    $PendingCompletionIds = @()
  }
}
Save-Ledger
# Completion delivery does not depend on VirtualDJ still being reachable.
Flush-PendingCompletions

Write-SwayHeading 'Checking VirtualDJ'
try {
  $clock = Invoke-VirtualDjRequest 'query' 'get_clock'
  Write-Host "VirtualDJ answered at $VirtualDjUrl." -ForegroundColor Green
} catch {
  Write-Host 'Sway could not reach VirtualDJ Network Control on this computer.' -ForegroundColor Red
  Write-Host 'Check that the extension is installed, Auto-Start is on, and the port/password match.' -ForegroundColor Yellow
  throw
}

Write-SwayHeading 'Connected'
Write-Host 'Leave this window open during the room. Sway now controls VirtualDJ.' -ForegroundColor Green
Write-Host 'Press Ctrl+C to disconnect.' -ForegroundColor DarkGray
$nextStateAt = [DateTimeOffset]::MinValue
$lastCloudWarning = $null

while ([DateTimeOffset]::UtcNow -lt $ExpiresAt) {
  try {
    # Publish the connected player/deck before Sway binds any command to this
    # short-lived bridge instance. Network failures stay in the retry loop.
    if ([DateTimeOffset]::UtcNow -ge $nextStateAt) {
      $state = Read-VirtualDjState $Deck
      [void](Invoke-SwayRequest '/api/talent/playback/bridge/state' 'POST' @{ gig_id = $GigId; state = $state })
      $nextStateAt = [DateTimeOffset]::UtcNow.AddSeconds(2)
    }
    Flush-PendingCompletions
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
        # The claimed command's deck is deliberate intent even if its response is lost.
        $Deck = Resolve-TargetDeck $command
        Save-Ledger
        $execution = $null
        try {
          $execution = Invoke-VirtualDjCommand $command
          $Deck = [int]$execution.result.deck
          $entry = @{ success = $true; result = $execution.result; error = $null; completedAt = [DateTimeOffset]::UtcNow.ToString('o') }
          Write-Host "VirtualDJ accepted $($command.action) on deck $($execution.result.deck); observation: $($execution.result.confirmationStatus)." -ForegroundColor Green
        } catch {
          $message = $_.Exception.Message
          if ($message.Length -gt 1000) { $message = $message.Substring(0, 1000) }
          $entry = @{ success = $false; result = @{}; error = $message; completedAt = [DateTimeOffset]::UtcNow.ToString('o') }
          Write-Host "VirtualDJ could not run $($command.action): $message" -ForegroundColor Red
        }
        $Ledger[$commandId] = $entry
        if ($PendingCompletionIds -notcontains $commandId) { $PendingCompletionIds += $commandId }
        Save-Ledger
        # Cloud observation delivery cannot change the durable player outcome.
        if ([bool]$entry.success -and $null -ne $execution.state) {
          try {
            [void](Invoke-SwayRequest '/api/talent/playback/bridge/state' 'POST' @{ gig_id = $GigId; state = $execution.state })
            $nextStateAt = [DateTimeOffset]::UtcNow.AddSeconds(2)
          } catch {
            Write-Host 'Player state will retry; the accepted command result is saved.' -ForegroundColor Yellow
          }
        }
      }
    }
    Flush-PendingCompletions

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

Write-Host 'This room connection expired. Open Room Tools in Sway and download a fresh room file.' -ForegroundColor Yellow
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
