import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildWindowsBoothLauncher } from '../src/server/windows-booth-launcher';
import { buildWindowsLibrarySyncLauncher } from '../src/server/windows-library-sync-launcher';

const gigId = '30000000-0000-4000-8000-000000000071';
const bridgeToken = "sway-room-token-with-a-'quote-and-enough-entropy";
const expiresAt = new Date(Date.now() + (6 * 60 * 60 * 1_000)).toISOString();
const launcher = buildWindowsBoothLauncher({
  swayUrl: 'https://app.sway.tips/',
  gigId,
  bridgeToken,
  expiresAt
});
const content = Buffer.from(launcher.contentBase64, 'base64');
const decoded = content.toString('utf8');

assert.equal(launcher.filename, 'sway-booth-30000000.cmd');
assert.equal(launcher.contentType, 'application/x-msdos-program');
assert.equal(launcher.expiresAt, expiresAt);
assert.equal(launcher.sha256, createHash('sha256').update(content).digest('hex'));
assert.ok(decoded.startsWith('@echo off\r\n'));
assert.ok(decoded.includes('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass'));
assert.ok(decoded.includes('# SWAY_BOOTH_POWERSHELL\r\n'));
assert.ok(decoded.includes("$SwayUrl = 'https://app.sway.tips'"));
assert.ok(decoded.includes("$GigId = '30000000-0000-4000-8000-000000000071'"));
assert.ok(decoded.includes("$AuthToken = 'sway-room-token-with-a-''quote-and-enough-entropy'"));

for (const term of [
  '$VirtualDjUrl = "http://127.0.0.1:$port"',
  '[Net.SecurityProtocolType]::Tls12',
  'Local\\SwayBooth-$GigId',
  'Sway Booth is already open for this room.',
  '-AsSecureString',
  'ZeroFreeBSTR($passwordPointer)',
  "Invoke-VirtualDjRequest 'query' 'get_clock'",
  "Invoke-VirtualDjRequest 'execute' $Script",
  "'load' {",
  "'play' {",
  "'pause' {",
  "'stop' {",
  "'cue' {",
  "'next' {",
  "'previous' {",
  'exact_library_path',
  'exact_track_confirmed',
  'source_acknowledged',
  'VirtualDJ response was lost; command outcome is uncertain.',
  'VirtualDJ state request failed.',
  "throw 'VirtualDJ rejected the command.'",
  'VirtualDJ accepted $($command.action)',
  '# Publish the connected player/deck before Sway binds any command',
  "'/api/talent/playback/bridge/claim'",
  "'/api/talent/playback/bridge/complete'",
  "'/api/talent/playback/bridge/state'",
  "GetFolderPath('LocalApplicationData')",
  'booth-ledger-$GigId.json',
  'authGeneration = $AuthGeneration',
  'pendingCompletionIds = @($PendingCompletionIds)',
  'function Flush-PendingCompletions',
  'Leave this window open during the room.',
  'This room connection expired.'
]) {
  assert.ok(decoded.includes(term), `launcher missing ${term}`);
}

const persistOutcomeAt = decoded.indexOf('$Ledger[$commandId] = $entry');
const pendingOutcomeAt = decoded.indexOf('$PendingCompletionIds += $commandId', persistOutcomeAt);
const saveOutcomeAt = decoded.indexOf('Save-Ledger', pendingOutcomeAt);
assert.ok(persistOutcomeAt > 0, 'launcher must persist each execution outcome');
assert.ok(pendingOutcomeAt > persistOutcomeAt && saveOutcomeAt > pendingOutcomeAt, 'launcher must persist pending completion before cloud acknowledgement');
assert.ok(!decoded.includes('--allow-remote'));
assert.ok(!decoded.includes('0.0.0.0'));
assert.ok(!decoded.includes('multipart/form-data'));
assert.ok(!decoded.includes('SWAY_CONTROL_AUTH_COOKIE'));
assert.ok(!decoded.includes('VirtualDJ rejected: $Script'), 'launcher errors must not echo a booth-local path');
assert.ok(!decoded.includes('virtualdj_search_first_result'));
assert.ok(!decoded.includes("$script = 'search \"'"), 'metadata-only loads must not mutate VirtualDJ');
assert.ok(decoded.includes("[string]$Command.action -eq 'pause' -and -not [bool]$state.playing"));
assert.ok(!decoded.includes("@('pause', 'stop', 'cue')"), 'stop/cue cannot claim state confirmation from a shared false flag');

const marker = '# SWAY_BOOTH_POWERSHELL\r\n';
const powerShellBody = decoded.slice(decoded.indexOf(marker) + marker.length);
const parsed = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
  '$source=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}'
], { input: powerShellBody, encoding: 'utf8' });
assert.equal(parsed.status, 0, `generated PowerShell must parse: ${parsed.stdout}${parsed.stderr}`);
const commandFunctionStart = powerShellBody.indexOf('switch ([string]$Command.action) {');
const commandFunctionEnd = powerShellBody.indexOf('[void](Invoke-VirtualDjExecute $script)', commandFunctionStart);
assert.ok(commandFunctionStart > 0 && commandFunctionEnd > commandFunctionStart);
const noPathHarness = [
  "$ErrorActionPreference = 'Stop'",
  '$Deck = 1',
  "$FutureExpiry = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')",
  '$ExecuteCalls = 0',
  '$Returned = $false',
  'function Invoke-VirtualDjExecute([string]$Script) { $script:ExecuteCalls += 1; return $true }',
  "$command = [pscustomobject]@{ action = 'load'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 2; track = [pscustomobject]@{ title = 'Metadata only' } } }",
  '$payload = $Command.payload',
  '$targetDeck = $Deck',
  '$script = $null',
  '$loadMatchMode = $null',
  '$track = $null',
  'try {',
  powerShellBody.slice(commandFunctionStart, commandFunctionEnd),
  '  [void](Invoke-VirtualDjExecute $script)',
  '  $Returned = $true',
  '} catch { }',
  'if ($Returned) { exit 2 }',
  'if ($ExecuteCalls -ne 0) { exit 3 }',
  'exit 0'
].join('\n');
const noPathEncoded = Buffer.from(noPathHarness, 'utf16le').toString('base64');
const noPathResult = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', noPathEncoded], { encoding: 'utf8' });
assert.equal(noPathResult.status, 0, `metadata-only generated load must execute zero mutations: ${noPathResult.stdout}${noPathResult.stderr}`);
assert.ok(decoded.indexOf('Flush-PendingCompletions\r\n    $claim =') > 0, 'pending completions flush before claims');
assert.ok(decoded.indexOf('$PendingCompletionIds += $commandId') < decoded.lastIndexOf('Flush-PendingCompletions'), 'new outcomes enter the independent completion flush');
assert.ok(decoded.indexOf('# Completion delivery does not depend on VirtualDJ still being reachable.\r\nFlush-PendingCompletions')
  < decoded.indexOf("Invoke-VirtualDjRequest 'query' 'get_clock'"), 'same-token restart flushes saved completion before the device check');

const authGeneration = createHash('sha256').update(bridgeToken, 'utf8').digest('hex');
assert.ok(decoded.includes(`$AuthGeneration = '${authGeneration}'`));
const sameGeneration = Buffer.from(buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips', gigId, bridgeToken, expiresAt }).contentBase64, 'base64').toString('utf8');
assert.ok(sameGeneration.includes(`$AuthGeneration = '${authGeneration}'`), 'same token restart uses the same generation fingerprint');
const replacementToken = `${bridgeToken}-replacement`;
const replacementGeneration = createHash('sha256').update(replacementToken, 'utf8').digest('hex');
const replacementLauncher = Buffer.from(buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips', gigId, bridgeToken: replacementToken, expiresAt }).contentBase64, 'base64').toString('utf8');
assert.ok(replacementLauncher.includes(`$AuthGeneration = '${replacementGeneration}'`));
assert.notEqual(replacementGeneration, authGeneration, 'replacement token rotates the persisted ledger generation');

// Run the emitted functions and startup restore in separate Windows PowerShell
// processes. Both cloud and player are injected; no actual player is launched.
const scratch = mkdtempSync(join(tmpdir(), 'sway-windows-recovery-'));
const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
const emittedFunctions = powerShellBody.slice(powerShellBody.indexOf('function Write-SwayHeading'), powerShellBody.indexOf('Clear-Host'));
const restoreStart = powerShellBody.indexOf('$BridgeInstanceId = [Guid]::NewGuid().ToString()');
const emittedRestore = powerShellBody.slice(restoreStart, powerShellBody.indexOf('# Completion delivery does not depend', restoreStart));
const loopStart = powerShellBody.indexOf('    foreach ($command in @($claim.commands))');
const emittedCommands = powerShellBody.slice(loopStart, powerShellBody.indexOf('    Flush-PendingCompletions', loopStart));
const commonHarness = [
  "$ErrorActionPreference = 'Stop'",
  `$GigId = ${psLiteral(gigId)}`,
  "$SourceKey = 'virtualdj'",
  `$AuthGeneration = ${psLiteral(authGeneration)}`,
  "$FutureExpiry = [DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o')",
  `$LedgerPath = ${psLiteral(join(scratch, 'ledger.json'))}`,
  emittedFunctions,
  'function Assert-Recovery([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; Write-Host "PASS: $Message" }'
].join('\n');
const runRecovery = (name: string, script: string) => {
  const harnessPath = join(scratch, `${name.replace(/[^a-z0-9]+/gi, '-')}.ps1`);
  writeFileSync(harnessPath, `\ufeff${script}`, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  process.stdout.write(result.stdout);
};
try {
  runRecovery('persist uncertain deck intent', [
    commonHarness,
    '$Deck = 1',
    emittedRestore,
    '$ExecuteCalls = 0',
    "function Invoke-VirtualDjExecute([string]$Script) { $script:ExecuteCalls += 1; $saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; Assert-Recovery ($saved.targetDeck -eq 4) 'deck is durable before player mutation'; Assert-Recovery ($Script -ceq 'deck 4 pause') 'pause addresses intended deck'; throw 'VirtualDJ response was lost; command outcome is uncertain.' }",
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'command-deck-four'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 4 } }) }",
    emittedCommands,
    "Assert-Recovery ($ExecuteCalls -eq 1) 'response loss executes once'",
    "$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json",
    "Assert-Recovery ($saved.targetDeck -eq 4 -and $saved.pendingCompletionIds -contains 'command-deck-four') 'uncertain outcome saves intended deck and pending completion'",
    "Assert-Recovery (-not $saved.outcomes.'command-deck-four'.success) 'response loss does not claim confirmed success'"
  ].join('\n'));
  runRecovery('same-token fresh-process recovery and receipt validation', [
    commonHarness,
    '$Deck = 1',
    emittedRestore,
    "Assert-Recovery ($Deck -eq 4) 'same-token fresh process restores deck four despite startup deck one'",
    '$ExecuteCalls = 0',
    "function Invoke-VirtualDjExecute([string]$Script) { $script:ExecuteCalls += 1; throw 'Unexpected replay' }",
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'command-deck-four'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 1 } }) }",
    emittedCommands,
    "Assert-Recovery ($ExecuteCalls -eq 0 -and $Deck -eq 4) 'duplicate uncertain command neither replays nor changes deck'",
    "foreach ($invalidDeck in @($null, 0, 9, '4.5', 'bad')) { Assert-Recovery ((Resolve-TargetDeck ([pscustomobject]@{ payload = [pscustomobject]@{ deck = $invalidDeck } })) -eq 4) 'invalid command deck uses current intended deck' }",
    "function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) { if ($Script -like 'deck *') { Assert-Recovery ($Script -like 'deck 4 *') 'recovered heartbeat observes intended deck' }; return 'false' }",
    '$state = Read-VirtualDjState',
    "Assert-Recovery ($state.deck -eq 4) 'recovered player state reports deck four'",
    'function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { return $script:Receipt }',
    "$validCommand = @{ id = 'command-deck-four'; gigId = $GigId; sourceKey = $SourceKey; status = 'failed' }",
    "$badReceipts = @($null, @{}, @{ success = $false; command = $validCommand }, @{ success = 'true'; command = $validCommand }, @{ success = $true }, @{ success = $true; command = @{ id = 'other'; gigId = $GigId; sourceKey = $SourceKey; status = 'failed' } }, @{ success = $true; command = @{ id = 'command-deck-four'; gigId = 'other'; sourceKey = $SourceKey; status = 'failed' } }, @{ success = $true; command = @{ id = 'command-deck-four'; gigId = $GigId; sourceKey = 'other'; status = 'failed' } }, @{ success = $true; command = @{ id = 'command-deck-four'; gigId = $GigId; sourceKey = $SourceKey; status = 'claimed' } }, @{ success = $true; command = @{ id = 'command-deck-four'; gigId = $GigId; sourceKey = $SourceKey; status = 'expired' } }, @{ success = $true; command = @{ id = 'command-deck-four'; gigId = $GigId; sourceKey = $SourceKey; status = 'succeeded' } })",
    '$case = 0',
    'foreach ($bad in $badReceipts) { $case += 1; $script:Receipt = $bad; Flush-PendingCompletions; $saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; Assert-Recovery ($PendingCompletionIds -contains "command-deck-four" -and $saved.pendingCompletionIds -contains "command-deck-four") "invalid completion receipt $case remains durably pending" }',
    '$script:Receipt = @{ success = $true; replay = $true; command = $validCommand }',
    'Flush-PendingCompletions',
    "Assert-Recovery ($PendingCompletionIds.Count -eq 0 -and (Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json).pendingCompletionIds.Count -eq 0) 'matching failed terminal receipt clears pending completion'",
    "$Ledger['command-success'] = @{ success = $true; result = @{ acknowledgement = 'accepted' }; error = $null; completedAt = [DateTimeOffset]::UtcNow.ToString('o') }; $PendingCompletionIds = @('command-success'); Save-Ledger",
    "$script:Receipt = @{ success = $true; command = @{ id = 'command-success'; gigId = $GigId; sourceKey = $SourceKey; status = 'failed' } }; Flush-PendingCompletions",
    "Assert-Recovery ($PendingCompletionIds -contains 'command-success') 'failed receipt cannot acknowledge successful outcome'",
    "$script:Receipt.command.status = 'succeeded'; Flush-PendingCompletions",
    "Assert-Recovery ($PendingCompletionIds.Count -eq 0) 'matching successful terminal receipt clears pending completion'",
    "Assert-Recovery ($ExecuteCalls -eq 0) 'completion retry performs no player mutations'",
    '$oldLedgerPath = $LedgerPath; $LedgerPath = Join-Path (Split-Path $LedgerPath) "blocked-ledger.json"; [void](New-Item -ItemType Directory -Path "$LedgerPath.tmp")',
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'new-command'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 3 } }) }; $saveRejected = $false; try {",
    emittedCommands,
    '} catch { $saveRejected = $true }; $LedgerPath = $oldLedgerPath',
    "Assert-Recovery ($saveRejected -and $ExecuteCalls -eq 0) 'failed intent persistence prevents player mutation'",
    "$Deck = 1; $AuthGeneration = 'replacement-generation'",
    emittedRestore,
    "Assert-Recovery ($Deck -eq 1 -and $Ledger.Count -eq 0 -and $PendingCompletionIds.Count -eq 0) 'new token generation uses configured fallback without old outcomes'",
    'foreach ($invalidDeck in @($null, 0, 9, "4.5", "bad")) { $document = @{ version = 2; authGeneration = $AuthGeneration; targetDeck = $invalidDeck; outcomes = @{}; pendingCompletionIds = @() }; $document | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $LedgerPath -Encoding UTF8; $Deck = 2;',
    emittedRestore,
    "Assert-Recovery ($Deck -eq 2) 'invalid saved deck uses configured fallback' }"
  ].join('\n'));
  runRecovery('accepted player action survives cloud state upload failure', [
    commonHarness,
    `$LedgerPath = ${psLiteral(join(scratch, 'state-upload-ledger.json'))}`,
    '$Deck = 1',
    emittedRestore,
    '$ExecuteCalls = 0; $StateUploadCalls = 0; $OutcomeWasDurable = $false',
    "function Invoke-VirtualDjExecute([string]$Script) { $script:ExecuteCalls += 1; Assert-Recovery ($Script -ceq 'deck 4 pause') 'accepted action targets deck four'; return 'true' }",
    "function Read-VirtualDjState([int]$TargetDeck = $Deck) { return @{ deck = $TargetDeck; playing = $false; observedAt = 'synthetic-observation'; trackTitle = 'Synthetic track'; trackArtist = 'Synthetic artist' } }",
    "function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { if ($Route -eq '/api/talent/playback/bridge/state') { $script:StateUploadCalls += 1; $saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; $script:OutcomeWasDurable = $saved.outcomes.'command-state-upload'.success -eq $true -and $saved.outcomes.'command-state-upload'.result.acknowledgement -ceq 'accepted' -and $saved.pendingCompletionIds -contains 'command-state-upload' -and $saved.targetDeck -eq 4; throw 'Synthetic cloud state upload failed' }; return $null }",
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'command-state-upload'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 4 } }) }",
    emittedCommands,
    "Assert-Recovery ($ExecuteCalls -eq 1 -and $StateUploadCalls -eq 1) 'accepted player mutation occurs once before failing cloud state upload'",
    "Assert-Recovery $OutcomeWasDurable 'accepted result and pending completion are durable before cloud state upload'",
    'Flush-PendingCompletions',
    '$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json',
    "Assert-Recovery ($saved.outcomes.'command-state-upload'.success -eq $true -and $null -eq $saved.outcomes.'command-state-upload'.error) 'cloud state failure cannot recategorize accepted outcome as failed'",
    "Assert-Recovery ($saved.outcomes.'command-state-upload'.result.acknowledgement -ceq 'accepted' -and $saved.outcomes.'command-state-upload'.result.deck -eq 4 -and $saved.outcomes.'command-state-upload'.result.confirmationStatus -ceq 'source_state_confirmed') 'cloud state failure retains exact accepted player result'",
    "Assert-Recovery ($saved.pendingCompletionIds -contains 'command-state-upload' -and $saved.targetDeck -eq 4) 'cloud state failure retains durable completion retry and deck'"
  ].join('\n'));
  runRecovery('fresh-process accepted action completion after cloud state failure', [
    commonHarness,
    `$LedgerPath = ${psLiteral(join(scratch, 'state-upload-ledger.json'))}`,
    '$Deck = 1',
    emittedRestore,
    '$ExecuteCalls = 0; $CompletionCalls = 0',
    "function Invoke-VirtualDjExecute([string]$Script) { $script:ExecuteCalls += 1; throw 'Unexpected replay' }",
    "Assert-Recovery ($Deck -eq 4 -and $Ledger['command-state-upload'].success -eq $true) 'fresh process restores accepted outcome and intended deck after state upload failure'",
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'command-state-upload'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 1 } }) }",
    emittedCommands,
    "Assert-Recovery ($ExecuteCalls -eq 0) 'accepted action is not replayed after state upload failure and restart'",
    "function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { $script:CompletionCalls += 1; $script:CompletionBody = $Body; return @{ success = $true; command = @{ id = 'command-state-upload'; gigId = $GigId; sourceKey = $SourceKey; status = 'succeeded' } } }",
    'Flush-PendingCompletions',
    "Assert-Recovery ($CompletionCalls -eq 1 -and $CompletionBody.success -eq $true -and $CompletionBody.result.acknowledgement -ceq 'accepted' -and $CompletionBody.result.deck -eq 4) 'completion reports saved accepted player outcome after state upload failure'",
    "Assert-Recovery ($PendingCompletionIds.Count -eq 0 -and (Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json).pendingCompletionIds.Count -eq 0) 'matching accepted completion receipt clears durable retry after state upload failure'",
    "Assert-Recovery ($ExecuteCalls -eq 0) 'accepted completion recovery performs zero player mutations'"
  ].join('\n'));
  runRecovery('strict emitted player execute acknowledgements', [
    commonHarness,
    `$LedgerPath = ${psLiteral(join(scratch, 'strict-ack-ledger.json'))}`,
    '$Deck = 1',
    emittedRestore,
    'function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) { $script:ExecuteCalls += 1; return $script:Ack }',
    "function Read-VirtualDjState([int]$TargetDeck = $Deck) { $script:ReadStateCalls += 1; return @{ deck = $TargetDeck; playing = $false; observedAt = 'synthetic-observation' } }",
    "function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { $script:StateUploadCalls += 1; return @{ success = $true } }",
    "$ackCase = 0; foreach ($ack in @('true', 'false', '1', 'on', 'yes', 'TRUE')) { $ackCase += 1; $script:Ack = $ack; $ExecuteCalls = 0; $ReadStateCalls = 0; $StateUploadCalls = 0; $testCommandId = 'strict-ack-' + $ackCase; $claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = $testCommandId; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 4 } }) };",
    emittedCommands,
    '$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; $outcome = $saved.outcomes.PSObject.Properties[$testCommandId].Value',
    "if ($ack -ceq 'true') { Assert-Recovery ($outcome.success -eq $true -and $outcome.result.acknowledgement -ceq 'accepted' -and $ExecuteCalls -eq 1 -and $ReadStateCalls -eq 1 -and $StateUploadCalls -eq 1) 'exact lowercase true acknowledgement records accepted action and observed state' } else { Assert-Recovery ($outcome.success -eq $false -and $null -eq $outcome.result.acknowledgement -and $ExecuteCalls -eq 1 -and $ReadStateCalls -eq 0 -and $StateUploadCalls -eq 0) \"execute acknowledgement $ack cannot create accepted outcome or observed state\" }",
    '}'
  ].join('\n'));
  runRecovery('emitted player state rejects unreadable playing responses', [
    commonHarness,
    `$LedgerPath = ${psLiteral(join(scratch, 'playing-state-ledger.json'))}`,
    '$Deck = 1',
    emittedRestore,
    '$ExecuteCalls = 0; $StateUploadCalls = 0',
    "function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) { if ($Endpoint -eq 'execute') { $script:ExecuteCalls += 1; return 'true' }; if ($Script -like 'deck * play') { return $script:PlayingResponse }; return '' }",
    "function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { $script:StateUploadCalls += 1; return @{ success = $true } }",
    "foreach ($playingResponse in @('true', 'yes', 'on', '1', 'TRUE', 'false', 'no', 'off', '0', 'FALSE')) { $script:PlayingResponse = $playingResponse; $state = Read-VirtualDjState 4; $expectedPlaying = $playingResponse -match '^(true|yes|on|1)$'; Assert-Recovery ($state.playing -is [bool] -and $state.playing -eq $expectedPlaying) \"documented playing query response $playingResponse produces readable state\" }",
    "foreach ($playingResponse in @($null, '', 'banana', 'unknown', ' ')) { $script:PlayingResponse = $playingResponse; $returned = $false; $unreadableError = $false; try { $state = Read-VirtualDjState 4; $returned = $true } catch { $unreadableError = $_.Exception.Message -ceq 'VirtualDJ returned an unreadable playback state.' }; Assert-Recovery (-not $returned -and $unreadableError) 'unreadable playing query cannot produce paused state' }",
    "$script:PlayingResponse = 'banana'; $claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'accepted-unreadable-state'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 4 } }) }",
    emittedCommands,
    '$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; $outcome = $saved.outcomes.PSObject.Properties["accepted-unreadable-state"].Value',
    "Assert-Recovery ($ExecuteCalls -eq 1 -and $outcome.success -eq $true -and $outcome.result.acknowledgement -ceq 'accepted') 'accepted pause remains accepted when state is unreadable'",
    "Assert-Recovery ($outcome.result.confirmationStatus -ceq 'source_acknowledged' -and $null -eq $outcome.result.observedPlaying -and $null -eq $outcome.result.observedAt -and $StateUploadCalls -eq 0) 'unreadable state cannot confirm pause or publish a false observation'"
  ].join('\n'));
  runRecovery('emitted load preserves exact track path identity', [
    commonHarness,
    `$LedgerPath = ${psLiteral(join(scratch, 'exact-track-ledger.json'))}`,
    '$Deck = 1',
    emittedRestore,
    '$ExecuteCalls = 0',
    "function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) { $script:ExecuteCalls += 1; return 'true' }",
    "function Read-VirtualDjState([int]$TargetDeck = $Deck) { return @{ deck = $TargetDeck; playing = $false; trackPath = $script:ObservedPath; observedAt = 'synthetic-observation' } }",
    "function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { return @{ success = $true } }",
    "$pathCases = @(@{ requested = 'C:/Music/A  B.mp3'; observed = 'C:/Music/A B.mp3'; expected = 'source_acknowledged'; label = 'distinct interior whitespace' }, @{ requested = 'C:/Music/Ａ.mp3'; observed = 'C:/Music/A.mp3'; expected = 'source_acknowledged'; label = 'distinct NFKC-equivalent Unicode' }, @{ requested = 'C:/Music/A.mp3'; observed = 'C:/Music/a.mp3'; expected = 'source_acknowledged'; label = 'distinct case' }, @{ requested = 'C:/Music/A  B.mp3'; observed = 'C:/Music/A  B.mp3'; expected = 'exact_track_confirmed'; label = 'identical path with interior whitespace' }, @{ requested = 'C:\\Music\\A.mp3'; observed = 'C:/Music/A.mp3'; expected = 'exact_track_confirmed'; label = 'identical path with different separators' }, @{ requested = 'C:/Music/Ａ.mp3'; observed = 'C:/Music/Ａ.mp3'; expected = 'exact_track_confirmed'; label = 'identical Unicode path' })",
    "$pathCase = 0; foreach ($path in $pathCases) { $pathCase += 1; $script:ObservedPath = $path.observed; $testCommandId = 'exact-path-' + $pathCase; $claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = $testCommandId; action = 'load'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 4; track = [pscustomobject]@{ path = $path.requested } } }) };",
    emittedCommands,
    '$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; $outcome = $saved.outcomes.PSObject.Properties[$testCommandId].Value',
    "Assert-Recovery ($outcome.success -eq $true -and $outcome.result.confirmationStatus -ceq $path.expected) \"exact track identity preserves $($path.label)\"",
    '}',
    "Assert-Recovery ($ExecuteCalls -eq $pathCases.Count) 'exact-track identity checks execute each load once'"
  ].join('\n'));
  runRecovery('emitted command loop refuses stale or invalid expiration', [
    commonHarness,
    `$LedgerPath = ${psLiteral(join(scratch, 'command-expiry-ledger.json'))}`,
    '$Deck = 1',
    emittedRestore,
    '$ExecuteCalls = 0; $StateUploadCalls = 0',
    "function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) { $script:ExecuteCalls += 1; return 'true' }",
    "function Read-VirtualDjState([int]$TargetDeck = $Deck) { return @{ deck = $TargetDeck; playing = $false; observedAt = 'synthetic-observation' } }",
    "function Invoke-SwayRequest([string]$Route, [string]$Method, [object]$Body) { $script:StateUploadCalls += 1; return @{ success = $true } }",
    "$expiryCases = @(@{ label = 'expired'; value = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o') }, @{ label = 'deadline equal to earlier current time'; value = [DateTimeOffset]::UtcNow.ToString('o') }, @{ label = 'malformed'; value = 'not-a-date' }, @{ label = 'missing'; value = $null })",
    "$expiryCase = 0; foreach ($expiry in $expiryCases) { $expiryCase += 1; $testCommandId = 'expired-command-' + $expiryCase; $testCommand = [pscustomobject]@{ id = $testCommandId; action = 'pause'; payload = [pscustomobject]@{ deck = 4 } }; if ($null -ne $expiry.value) { $testCommand | Add-Member -NotePropertyName expiresAt -NotePropertyValue $expiry.value }; $claim = [pscustomobject]@{ commands = @($testCommand) };",
    emittedCommands,
    '$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; $outcome = $saved.outcomes.PSObject.Properties[$testCommandId].Value',
    "Assert-Recovery ($ExecuteCalls -eq 0 -and $StateUploadCalls -eq 0) \"$($expiry.label) expiration performs zero player mutations or state uploads\"",
    "Assert-Recovery ($outcome.success -eq $false -and $null -eq $outcome.result.acknowledgement -and $outcome.error -ceq 'Playback command expired or has an invalid deadline. Send a fresh command.' -and $saved.pendingCompletionIds -contains $testCommandId) \"$($expiry.label) expiration records honest durable failure\"",
    '}',
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'future-valid-command'; action = 'pause'; expiresAt = $FutureExpiry; payload = [pscustomobject]@{ deck = 4 } }) }",
    emittedCommands,
    "$saved = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json; Assert-Recovery ($ExecuteCalls -eq 1 -and $saved.outcomes.'future-valid-command'.success -eq $true -and $saved.outcomes.'future-valid-command'.result.acknowledgement -ceq 'accepted') 'future valid expiration permits normal player execution'",
    "$claim = [pscustomobject]@{ commands = @([pscustomobject]@{ id = 'future-valid-command'; action = 'pause'; expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o'); payload = [pscustomobject]@{ deck = 4 } }) }",
    emittedCommands,
    "Assert-Recovery ($ExecuteCalls -eq 1 -and $Ledger['future-valid-command'].success -eq $true) 'saved outcome deduplicates without execution after its deadline passes'"
  ].join('\n'));
} finally {
  assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + '\\'), 'scratch cleanup stays within temporary directory');
  rmSync(scratch, { recursive: true, force: true });
}

assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'http://app.sway.tips', gigId, bridgeToken, expiresAt }),
  /requires HTTPS/
);
assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips/untrusted-path', gigId, bridgeToken, expiresAt }),
  /invalid Sway origin/
);
assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips', gigId: 'not-a-room', bridgeToken, expiresAt }),
  /valid live-room id/
);
assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips', gigId, bridgeToken: `${bridgeToken}\r\nInjected`, expiresAt }),
  /valid room-scoped token/
);
assert.throws(
  () => buildWindowsBoothLauncher({
    swayUrl: 'https://app.sway.tips',
    gigId,
    bridgeToken,
    expiresAt: new Date(Date.now() + (8 * 60 * 60 * 1_000)).toISOString()
  }),
  /short-lived room connection/
);

const librarySyncKey = `sway_lib_${'ab'.repeat(24)}`;
const libraryLauncher = buildWindowsLibrarySyncLauncher({
  swayUrl: 'https://app.sway.tips/',
  sourceKey: 'main-booth-laptop',
  syncKey: librarySyncKey
});
const libraryContent = Buffer.from(libraryLauncher.contentBase64, 'base64');
const libraryDecoded = libraryContent.toString('utf8');
assert.equal(libraryLauncher.filename, 'sway-music-main-booth-laptop.cmd');
assert.equal(libraryLauncher.contentType, 'application/x-msdos-program');
assert.equal(libraryLauncher.sha256, createHash('sha256').update(libraryContent).digest('hex'));
for (const term of [
  '# SWAY_MUSIC_HELPER_POWERSHELL',
  'SWAY MUSIC HELPER',
  'Choose your latest DJ library export.',
  'System.Windows.Forms.OpenFileDialog',
  'x-sway-library-filename',
  'x-sway-library-key',
  '/api/library/import-file',
  'Your audio files stay on this computer.',
  "COULDN'T UPDATE YOUR MUSIC",
  'Nothing was removed. Check your connection or make a fresh helper in Sway.',
  'DONE - $count $trackReady ready in every room.',
  'Keep this helper. Double-click it again after your DJ library changes.'
]) {
  assert.ok(libraryDecoded.includes(term), `music helper missing ${term}`);
}
assert.ok(libraryDecoded.includes(`$SyncKey = '${librarySyncKey}'`));
assert.ok(!libraryDecoded.includes('/api/session'));
assert.ok(!libraryDecoded.includes('/api/talent/playback'));
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'http://app.sway.tips', sourceKey: 'main-booth', syncKey: librarySyncKey }),
  /requires HTTPS/
);
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'https://app.sway.tips/untrusted', sourceKey: 'main-booth', syncKey: librarySyncKey }),
  /invalid Sway origin/
);
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'https://app.sway.tips', sourceKey: '../unsafe', syncKey: librarySyncKey }),
  /valid source id/
);
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'https://app.sway.tips', sourceKey: 'main-booth', syncKey: `${librarySyncKey}\r\ninjected` }),
  /valid private sync key/
);

console.log('Sway Windows booth launcher tests passed.');
