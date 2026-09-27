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
  $normalized = ([string]$Value).Trim()
  if ($normalized -match '^(true|yes|on|1)$') { return $true }
  if ($normalized -match '^(false|no|off|0)$') { return $false }
  throw 'VirtualDJ returned an unreadable playback state. Controls remain unavailable.'
}

function Invoke-SwayRequest([string]$Route, [string]$Method = 'GET', [object]$Body = $null) {
  $headers = @{ Authorization = "Bearer $AuthToken"; Accept = 'application/json' }
  $parameters = @{
    Uri = "$SwayUrl$Route"
    Method = $Method
    Headers = $headers
    TimeoutSec = 12
    MaximumRedirection = 0
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
    MaximumRedirection = 0
    UseBasicParsing = $true
  }
  $response = Invoke-WebRequest @parameters
  return ([string]$response.Content).Trim()
}

function Invoke-VirtualDjExecute([string]$Script) {
  $result = Invoke-VirtualDjRequest 'execute' $Script
  if ($result -cne 'true') {
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
  if ($Value -is [System.Collections.IDictionary]) {
    foreach ($key in $Value.Keys) { $table[[string]$key] = $Value[$key] }
  } elseif ($Value -is [System.Management.Automation.PSCustomObject]) {
    foreach ($property in $Value.PSObject.Properties) { $table[$property.Name] = $property.Value }
  } else { throw 'Invalid booth ledger object. Preserve the file; do not reset it.' }
  return $table
}

function Test-SwayCommandId([string]$Value) {
  $parsed = [Guid]::Empty
  return [Guid]::TryParseExact($Value, 'D', [ref]$parsed)
}

function Initialize-SwayLedger {
  $script:Ledger = @{}
  $script:PendingCompletionIds = @()
  if (Test-Path -LiteralPath $LedgerPath) {
    try {
      if ((Get-Item -LiteralPath $LedgerPath).Length -gt 4194304) { throw 'Ledger is too large.' }
      $stored = [IO.File]::ReadAllText($LedgerPath) | ConvertFrom-Json
      $legacy = $null -eq $stored.PSObject.Properties['version']
      if ($legacy) {
        $script:Ledger = ConvertTo-LedgerTable $stored
        $script:PendingCompletionIds = @($Ledger.Keys)
      } else {
        if ($stored.version -ne 1 -or $stored.gigId -cne $GigId -or $stored.sourceKey -cne $SourceKey -or
            -not (Test-SwayCommandId $stored.bridgeInstanceId) -or -not ($stored.pendingCompletionIds -is [array])) {
          throw 'Invalid booth ledger identity or structure.'
        }
        $script:BridgeInstanceId = [string]$stored.bridgeInstanceId
        $script:Ledger = ConvertTo-LedgerTable $stored.outcomes
        $script:PendingCompletionIds = @($stored.pendingCompletionIds)
      }
      foreach ($id in @($Ledger.Keys)) {
        $entry = ConvertTo-LedgerTable $Ledger[$id]
        $date = [DateTimeOffset]::MinValue
        $timestamp = if ($legacy) { $entry.completedAt } else { $entry.finishedAt }
        if (-not (Test-SwayCommandId $id) -or -not ($entry.success -is [bool]) -or
            -not ($timestamp -is [string]) -or -not [DateTimeOffset]::TryParse($timestamp, [ref]$date) -or
            -not ($null -eq $entry.error -or $entry.error -is [string])) { throw 'Invalid execution outcome.' }
        $entry.result = ConvertTo-LedgerTable $entry.result
        if ($legacy) {
          $entry.finishedAt = $timestamp
          $entry.Remove('completedAt')
          if (-not $entry.success) { $entry.result.executionStatus = 'unknown' }
        }
        if ($entry.success -and $entry.result.executionStatus -eq 'unknown') { throw 'Contradictory execution outcome.' }
        if (-not $entry.success -and $entry.result.executionStatus -ne 'unknown') { throw 'Unclassified failed outcome.' }
        if ($entry.ContainsKey('reviewedAt') -and
            (-not ($entry.reviewedAt -is [string]) -or -not [DateTimeOffset]::TryParse($entry.reviewedAt, [ref]$date))) {
          throw 'Invalid operator review receipt.'
        }
        $script:Ledger[$id] = $entry
      }
      foreach ($id in $PendingCompletionIds) {
        if (-not ($id -is [string]) -or -not $Ledger.ContainsKey($id)) { throw 'Pending completion has no outcome.' }
      }
    } catch {
      throw 'Cannot safely resume the booth ledger. Preserve it and check the original player; no commands were dispatched.'
    }
  }
  Save-Ledger
}

function Save-Ledger {
  $retained = @{}
  $recent = @($Ledger.GetEnumerator() | Where-Object {
    $PendingCompletionIds -notcontains [string]$_.Key -and $_.Value.result.executionStatus -ne 'unknown'
  } | Sort-Object { [string]$_.Value.finishedAt } -Descending | Select-Object -First 250)
  foreach ($entry in $recent) { $retained[[string]$entry.Key] = $entry.Value }
  foreach ($id in $Ledger.Keys) {
    if ($PendingCompletionIds -contains $id -or $Ledger[$id].result.executionStatus -eq 'unknown') { $retained[$id] = $Ledger[$id] }
  }
  $record = [ordered]@{version=1;gigId=$GigId;sourceKey=$SourceKey;bridgeInstanceId=$BridgeInstanceId;
    outcomes=$retained;pendingCompletionIds=@($PendingCompletionIds | Select-Object -Unique)}
  $json = $record | ConvertTo-Json -Depth 14 -Compress
  $encoder = [Text.UTF8Encoding]::new($false)
  $bytes = $encoder.GetBytes($json)
  if ($bytes.Length -gt 4194304) { throw 'Booth ledger is full; preserved outcomes must be reviewed before more commands.' }
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LedgerPath))
  $temporaryPath = $LedgerPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    $stream = [IO.FileStream]::new($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
      [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($LedgerPath)) { [IO.File]::Replace($temporaryPath,$LedgerPath,[NullString]::Value) }
    else { [IO.File]::Move($temporaryPath,$LedgerPath) }
    $script:Ledger = $retained
  } finally { if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) } }
}

function Invoke-SwayClaimedOnce([object]$Command) {
  $commandId = [string]$Command.id
  if (-not (Test-SwayCommandId $commandId)) { throw 'A durable Sway command identity is required.' }
  if ($Ledger.ContainsKey($commandId)) {
    if ($PendingCompletionIds -notcontains $commandId) {
      $script:PendingCompletionIds += $commandId
      Save-Ledger
    }
    return $Ledger[$commandId]
  }
  $entry = @{success=$false;result=@{executionStatus='unknown'};
    error='Player dispatch is unconfirmed. Check VirtualDJ; this command will not be replayed.';
    finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  $script:Ledger[$commandId] = $entry
  $script:PendingCompletionIds += $commandId
  # A failed durable reservation prevents all player I/O.
  Save-Ledger
  try {
    $result = Invoke-VirtualDjCommand $Command
    $finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $result.executedAt = $finishedAt
    $entry = @{success=$true;result=$result;error=$null;finishedAt=$finishedAt}
    Write-Host "VirtualDJ acknowledged $($Command.action). Playback is checked separately." -ForegroundColor Green
  } catch {
    $entry = @{success=$false;result=@{executionStatus='unknown'};
      error='Player did not confirm the command. Check VirtualDJ; this command will not be replayed.';
      finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
    Write-Host $entry.error -ForegroundColor Yellow
  }
  $script:Ledger[$commandId] = $entry
  Save-Ledger
  return $entry
}

function Test-SwayReviewRequired {
  foreach ($entry in $Ledger.Values) {
    if ($entry.result.executionStatus -eq 'unknown' -and -not $entry.reviewedAt) { return $true }
  }
  return $false
}

function Confirm-SwayRecovery {
  if (-not (Test-SwayReviewRequired)) { return $true }
  $observed = Read-VirtualDjState
  $stateLabel = if ($observed.playing) { 'playing' } else { 'paused' }
  Write-Host "VirtualDJ currently reports $stateLabel. A previous command outcome remains unknown." -ForegroundColor Yellow
  Write-Host 'Check the original deck before continuing. The previous command will never be repeated.' -ForegroundColor Yellow
  $answer = Read-Host 'Type CONTINUE to accept new commands, or anything else to stop'
  if ($answer -cne 'CONTINUE') { return $false }
  foreach ($entry in $Ledger.Values) {
    if ($entry.result.executionStatus -eq 'unknown' -and -not $entry.reviewedAt) {
      $entry.reviewedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
  }
  Save-Ledger
  return $true
}

function Flush-SwayCompletions {
  foreach ($commandId in @($PendingCompletionIds)) {
    $before = @($PendingCompletionIds)
    try {
      Complete-SwayCommand $commandId $Ledger[$commandId]
      $script:PendingCompletionIds = @($PendingCompletionIds | Where-Object { $_ -ne $commandId })
      Save-Ledger
    } catch {
      $script:PendingCompletionIds = $before
      Write-Host 'Command result will retry; no new player commands will be claimed.' -ForegroundColor Yellow
      return $false
    }
  }
  return $true
}

function Invoke-SwayBridgeTick {
  $completionsReady = Flush-SwayCompletions
  if ($completionsReady -and -not (Test-SwayReviewRequired)) {
    $claim = Invoke-SwayRequest '/api/talent/playback/bridge/claim' 'POST' @{
      gig_id=$GigId;sourceKey=$SourceKey;bridgeInstanceId=$BridgeInstanceId
    }
    foreach ($command in @($claim.commands)) {
      $entry = Invoke-SwayClaimedOnce $command
      if ($entry.result.executionStatus -eq 'unknown') { break }
    }
    [void](Flush-SwayCompletions)
  }
  if ($null -eq $nextStateAt -or [DateTimeOffset]::UtcNow -ge $nextStateAt) {
    try { $state = Read-VirtualDjState } catch {
      $state = @{sourceKey=$SourceKey;transport='virtualdj_network_control_http_windows_companion';
        bridgeInstanceId=$BridgeInstanceId;connectionStatus='disconnected';deck=$Deck;
        observedAt=[DateTimeOffset]::UtcNow.ToString('o');metadata=@{error='Player state could not be confirmed.'}}
    }
    [void](Invoke-SwayRequest '/api/talent/playback/bridge/state' 'POST' @{gig_id=$GigId;state=$state})
    $script:nextStateAt = [DateTimeOffset]::UtcNow.AddSeconds(2)
  }
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
  [void](Read-VirtualDjState)
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
$PendingCompletionIds = @()
Initialize-SwayLedger

Write-SwayHeading 'Connected'
Write-Host 'Leave this window open during the room. Waiting for your Sway commands; no music was started by setup.' -ForegroundColor Green
Write-Host 'Press Ctrl+C to disconnect.' -ForegroundColor DarkGray
$nextStateAt = [DateTimeOffset]::MinValue
$lastCloudWarning = $null

while ([DateTimeOffset]::UtcNow -lt $ExpiresAt) {
  try {
    if ((Test-SwayReviewRequired) -and -not (Confirm-SwayRecovery)) {
      Write-Host 'Sway Booth stopped. Previous command outcomes were preserved.' -ForegroundColor Yellow
      break
    }
    Invoke-SwayBridgeTick
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

if ([DateTimeOffset]::UtcNow -ge $ExpiresAt) {
  Write-Host 'This room connection expired. Open Room Tools in Sway and download a fresh room file.' -ForegroundColor Yellow
}
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
