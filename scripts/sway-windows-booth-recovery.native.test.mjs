import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWindowsBoothLauncher } from '../src/server/windows-booth-launcher.ts';

assert.equal(process.platform, 'win32', 'Native booth proof requires Windows PowerShell; no simulated pass.');
const root = mkdtempSync(path.join(tmpdir(), 'sway-booth-native-'));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const launcher = buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips',
  gigId: '30000000-0000-4000-8000-000000000071', bridgeToken: 'synthetic-booth-token-not-a-real-grant',
  expiresAt: new Date(Date.now() + 3600000).toISOString() });
const decoded = Buffer.from(launcher.contentBase64, 'base64').toString('utf8');
const body = decoded.slice(decoded.indexOf('# SWAY_BOOTH_POWERSHELL\r\n') + '# SWAY_BOOTH_POWERSHELL\r\n'.length);
const sourcePath = path.join(root, 'generated.ps1');
writeFileSync(sourcePath, body);
const harness = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(__SOURCE__, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Generated Windows booth has PowerShell syntax errors.' }
$functions = $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($function in $functions) { . ([ScriptBlock]::Create($function.Extent.Text)) }
# Only generated functions execute. No startup, user ledger, cloud or player is accessed.
$GigId = '30000000-0000-4000-8000-000000000071'; $SourceKey = 'virtualdj'; $Deck = 2
$BridgeInstanceId = [Guid]::NewGuid().ToString(); $VirtualDjUrl = 'http://127.0.0.1:1'
$LedgerPath = __LEDGER__; $Ledger = @{}; $PendingCompletionIds = @(); $Checks = @()
$PlayingReply = 'false'; $ExecuteReply = 'true'; $Executions = 0; $CloudCalls = 0
function Assert-Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Reject([scriptblock]$Action, [string]$Message) {
  $failed = $false; try { & $Action | Out-Null } catch { $failed = $true }
  Assert-Check $failed $Message
}
function Pass([string]$Name) { $script:Checks += $Name; Write-Output ('WINDOWS_BOOTH_NATIVE_PASS ' + $Name) }
function Invoke-VirtualDjRequest([string]$Endpoint, [string]$Script) {
  if ($Endpoint -eq 'execute') { $script:Executions++; return $ExecuteReply }
  if ($Script.EndsWith(' play')) { return $PlayingReply }
  if ($Script.EndsWith(' get_position')) { return '0.25' }
  if ($Script.EndsWith(' get_bpm')) { return '128' }
  return 'synthetic-fixture'
}
foreach ($reply in @('unknown', '', '<html>login</html>')) {
  $PlayingReply = $reply
  Assert-Reject { Read-VirtualDjState } 'Unreadable state must not be projected as connected/paused.'
}
$PlayingReply = 'false'; Assert-Check ((Read-VirtualDjState).playing -eq $false) 'Paused state lost.'
$PlayingReply = 'true'; Assert-Check ((Read-VirtualDjState).playing -eq $true) 'Playing state lost.'
Pass 'unknown playback is rejected; true and false remain distinct'
foreach ($reply in @('1','on','yes','TRUE','false','unexpected')) {
  $ExecuteReply = $reply
  Assert-Reject { Invoke-VirtualDjExecute 'deck 2 play on' } 'Only exact true may acknowledge execution.'
}
$ExecuteReply = 'true'; [void](Invoke-VirtualDjExecute 'deck 2 pause')
Pass 'execution accepts only the documented exact true acknowledgement'
$Executions = 0
Initialize-SwayLedger
$initialIdentity = $BridgeInstanceId
$command = [pscustomobject]@{id='40000000-0000-4000-8000-000000000071';action='next';payload=[pscustomobject]@{deck=2}}
function Invoke-VirtualDjCommand([object]$Command) {
  $saved = [IO.File]::ReadAllText($LedgerPath) | ConvertFrom-Json
  $reserved = $saved.outcomes.PSObject.Properties[[string]$Command.id].Value
  Assert-Check ($reserved.result.executionStatus -eq 'unknown') 'Unknown outcome must be durable before dispatch.'
  Assert-Check (@($saved.pendingCompletionIds) -contains [string]$Command.id) 'Pending completion not durable.'
  $script:Executions++
  throw 'Synthetic command response lost after delivery.'
}
$entry = Invoke-SwayClaimedOnce $command
Assert-Check ($Executions -eq 1 -and $entry.result.executionStatus -eq 'unknown') 'Lost response not retained.'
$BridgeInstanceId = [Guid]::NewGuid().ToString(); $Ledger = @{}; $PendingCompletionIds = @()
Initialize-SwayLedger
Assert-Check ($BridgeInstanceId -eq $initialIdentity) 'Restart changed the bridge identity.'
$again = Invoke-SwayClaimedOnce $command
Assert-Check ($Executions -eq 1 -and $again.result.executionStatus -eq 'unknown') 'Restart replayed an unknown command.'
Pass 'durable reservation precedes dispatch; restart retains identity and never repeats unknown command'
function Invoke-SwayRequest([string]$Route, [string]$Method='GET', [object]$Body=$null) {
  $script:CloudCalls++
  if ($Route.EndsWith('/complete')) { throw 'Synthetic completion unavailable.' }
  if ($Route.EndsWith('/state')) { return @{} }
  throw 'A new claim must not occur during unresolved recovery.'
}
Invoke-SwayBridgeTick
Assert-Check ($Executions -eq 1) 'Pending completion dispatched another player action.'
Assert-Check ($PendingCompletionIds.Count -eq 1) 'Failed completion was dropped.'
Pass 'completion failure blocks new claims without erasing the retry record'
function Invoke-SwayRequest([string]$Route, [string]$Method='GET', [object]$Body=$null) {
  $script:CloudCalls++
  if ($Route.EndsWith('/complete') -or $Route.EndsWith('/state')) { return @{} }
  throw 'An unreviewed unknown outcome must not admit a new claim.'
}
Invoke-SwayBridgeTick
Assert-Check ($PendingCompletionIds.Count -eq 0 -and (Test-SwayReviewRequired)) 'Completion acknowledgement cleared uncertainty.'
Pass 'acknowledged unknown outcome still requires deliberate operator review'
function Read-Host([string]$Prompt) { return 'STOP' }
Assert-Check (-not (Confirm-SwayRecovery)) 'Canceled recovery must keep commands stopped.'
Assert-Check (Test-SwayReviewRequired) 'Canceled recovery changed the hold.'
function Read-Host([string]$Prompt) { return 'CONTINUE' }
$PlayingReply = 'unknown'
Assert-Reject { Confirm-SwayRecovery } 'Unreadable current player state must block recovery.'
$PlayingReply = 'false'
Assert-Check (Confirm-SwayRecovery) 'Explicit recovery did not acknowledge the unknown outcome.'
Assert-Check (-not (Test-SwayReviewRequired)) 'Review remained blocked after explicit confirmation.'
$again = Invoke-SwayClaimedOnce $command
Assert-Check ($Executions -eq 1) 'Operator review replayed the old command.'
Pass 'operator must confirm after readable current state; old command remains non-replayable'
$original = [IO.File]::ReadAllText($LedgerPath)
[IO.File]::WriteAllText($LedgerPath, '{broken')
Assert-Reject { Initialize-SwayLedger } 'Corrupt ledger must fail closed, never reset to empty.'
Assert-Check ([IO.File]::ReadAllText($LedgerPath) -eq '{broken') 'Corrupt evidence was overwritten.'
[IO.File]::WriteAllText($LedgerPath, $original)
$foreign = $original.Replace($GigId, '30000000-0000-4000-8000-000000000072')
[IO.File]::WriteAllText($LedgerPath, $foreign)
Assert-Reject { Initialize-SwayLedger } 'Foreign room ledger must be refused.'
[IO.File]::WriteAllText($LedgerPath, $original)
Initialize-SwayLedger
Pass 'corrupt and foreign-room ledgers remain preserved and cannot silently resume'
$legacy = @{}; $legacy[$command.id] = @{success=$false;result=@{};error='Old lost response';completedAt=[DateTimeOffset]::UtcNow.ToString('o')}
[IO.File]::WriteAllText($LedgerPath, ($legacy | ConvertTo-Json -Depth 10))
Initialize-SwayLedger
Assert-Check ($Ledger[$command.id].result.executionStatus -eq 'unknown') 'Legacy failure must remain conservatively uncertain.'
Assert-Check ($PendingCompletionIds -contains $command.id) 'Legacy completion was not retained.'
Pass 'valid legacy outcomes migrate conservatively; failed outcomes cannot become replayable'
$old = $Ledger[$command.id]; $old.finishedAt = '2001-01-01T00:00:00.000Z'; $PendingCompletionIds = @()
for ($i=0; $i -lt 260; $i++) { $Ledger[[Guid]::NewGuid().ToString()] = @{success=$true;result=@{executed=$true};error=$null;finishedAt=[DateTimeOffset]::UtcNow.ToString('o')} }
Save-Ledger
Initialize-SwayLedger
Assert-Check ($Ledger.ContainsKey($command.id)) 'Retention discarded an unresolved command.'
Pass 'bounded history never drops unknown or pending outcomes'
$Ledger = @{}; $PendingCompletionIds = @(); $savedPath = $LedgerPath
$LedgerPath = Join-Path $LedgerPath 'invalid-child.json'
$before = $Executions
Assert-Reject { Invoke-SwayClaimedOnce $command } 'Persistence failure must reject command execution.'
Assert-Check ($Executions -eq $before) 'Player action escaped a failed reservation write.'
$LedgerPath = $savedPath
Pass 'failed pre-dispatch persistence sends zero player commands'
$LedgerPath = Join-Path ([IO.Path]::GetDirectoryName($savedPath)) 'batch.json'
$BridgeInstanceId = [Guid]::NewGuid().ToString(); Initialize-SwayLedger
$Executions=0; $ClaimCalls=0; $LastState=$null; $nextStateAt=[DateTimeOffset]::MinValue
$first=[pscustomobject]@{id='40000000-0000-4000-8000-000000000075';action='next';payload=[pscustomobject]@{deck=2}}
$later=[pscustomobject]@{id='40000000-0000-4000-8000-000000000076';action='play';payload=[pscustomobject]@{deck=2}}
$claimItems=@($first,$later)
function Invoke-SwayRequest([string]$Route,[string]$Method='GET',[object]$Body=$null) {
  if ($Route.EndsWith('/claim')) { $script:ClaimCalls++; return @{commands=$claimItems} }
  if ($Route.EndsWith('/state')) { $script:LastState=$Body.state }
  return @{}
}
function Invoke-VirtualDjCommand([object]$Command) { $script:Executions++; throw 'Synthetic ambiguous dispatch.' }
$PlayingReply='false'
Invoke-SwayBridgeTick
Assert-Check ($Executions -eq 1 -and -not $Ledger.ContainsKey($later.id)) 'Ambiguous next allowed later play in the same batch.'
Invoke-SwayBridgeTick
Assert-Check ($ClaimCalls -eq 1 -and $Executions -eq 1) 'Unreviewed outcome allowed another claim.'
Pass 'ambiguous command stops the rest of its batch and all later automatic claims'
$PlayingReply='unknown'; $nextStateAt=[DateTimeOffset]::MinValue
Invoke-SwayBridgeTick
Assert-Check ($LastState.connectionStatus -eq 'disconnected' -and -not $LastState.ContainsKey('playing')) 'Unreadable feedback fabricated a paused player.'
Pass 'unreadable live feedback publishes disconnected rather than invented paused state'
$PlayingReply='false'
Assert-Check (Confirm-SwayRecovery) 'Explicit operator review did not permit new actions.'
$claimItems=@($later)
function Invoke-VirtualDjCommand([object]$Command) { $script:Executions++; return @{executed=$true;action=$Command.action;deck=2} }
Invoke-SwayBridgeTick
Assert-Check ($Executions -eq 2 -and $Ledger[$later.id].success -and $PendingCompletionIds.Count -eq 0) 'New explicit action failed after review.'
[void](Invoke-SwayClaimedOnce $first)
Assert-Check ($Executions -eq 2) 'Old uncertain command replayed after a successful new action.'
Pass 'deliberate review permits a new command without reviving the uncertain one'
$stable=[IO.File]::ReadAllText($LedgerPath)
$invalid=$stable | ConvertFrom-Json
$invalid.outcomes.PSObject.Properties[$later.id].Value.success='true'
$corrupt=$invalid | ConvertTo-Json -Depth 14 -Compress
[IO.File]::WriteAllText($LedgerPath,$corrupt)
Assert-Reject { Initialize-SwayLedger } 'String boolean must not grant confirmed outcome authority.'
Assert-Check ([IO.File]::ReadAllText($LedgerPath) -eq $corrupt) 'Malformed authority was overwritten.'
Pass 'malformed saved outcome authority fails closed without rewriting evidence'
Write-Output ('WINDOWS_BOOTH_NATIVE_SUMMARY ' + (@{passed=$true;checks=$Checks;physicalPlayer=$false;realProviderCalls=0;productionWrites=$false;scope='Actual generated PowerShell functions; synthetic transport and owned temporary ledger'} | ConvertTo-Json -Depth 8 -Compress))
`;
try {
  const script = harness.replace('__SOURCE__',quote(sourcePath)).replace('__LEDGER__',quote(path.join(root,'ledger.json')));
  const command = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ' + script;
  const result = spawnSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], {
    encoding:'utf8',timeout:45000,windowsHide:true,maxBuffer:4*1024*1024 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert(!result.error && !result.signal && result.status===0, 'Generated Windows booth native behavior failed.');
  assert(result.stdout.includes('WINDOWS_BOOTH_NATIVE_SUMMARY '), 'Native receipt missing.');
  // Separate operating-system processes exercise a crash after the actual durable write.
  const marker = path.join(root,'dispatches.txt');
  const crashLedger = path.join(root,'crash-ledger.json');
  const boot = script.slice(0,script.indexOf('foreach ($reply in'))
    .replace(quote(path.join(root,'ledger.json')),()=>quote(crashLedger));
  const commandLiteral = "$command = [pscustomobject]@{id='40000000-0000-4000-8000-000000000074';action='next';payload=[pscustomobject]@{deck=2}}";
  const die = boot + '\nInitialize-SwayLedger\n' + commandLiteral + '\n' +
    'function Invoke-VirtualDjCommand([object]$Command) { [IO.File]::AppendAllText(' + quote(marker) + ", 'dispatched' + [Environment]::NewLine); [Environment]::Exit(73) }\n" +
    '[void](Invoke-SwayClaimedOnce $command)';
  const interrupted = spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',die],
    {encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:1024*1024});
  assert.equal(interrupted.status,73,'Owned crash fixture did not exit at the dispatch boundary: ' + interrupted.stderr);
  const unknown = JSON.parse(readFileSync(crashLedger,'utf8'));
  assert.equal(unknown.outcomes['40000000-0000-4000-8000-000000000074'].result.executionStatus,'unknown');
  const resume = boot + '\nInitialize-SwayLedger\n' + commandLiteral + '\n' +
    'function Invoke-VirtualDjCommand([object]$Command) { [IO.File]::AppendAllText(' + quote(marker) + ", 'REPLAYED'); throw 'must not run' }\n" +
    '[void](Invoke-SwayClaimedOnce $command)\nAssert-Check (Test-SwayReviewRequired) \'Crash outcome was not held for review.\'\n' +
    'Assert-Check ($BridgeInstanceId -eq ' + quote(unknown.bridgeInstanceId) + ") 'Restart changed identity.'";
  const resumed = spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',resume],
    {encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:1024*1024});
  assert.equal(resumed.status,0,'Restart fixture failed: ' + resumed.stderr);
  assert.equal(readFileSync(marker,'utf8').trim(),'dispatched','Crash restart replayed the prior player operation.');
  console.log('WINDOWS_BOOTH_PROCESS_RESTART_PASS ' + JSON.stringify({actualPowerShellProcesses:2,firstExit:73,restartExit:0,dispatchCount:1,unknownPreserved:true,bridgeIdentityPreserved:true,physicalPlayer:false}));

} finally { rmSync(root,{recursive:true,force:true}); }
