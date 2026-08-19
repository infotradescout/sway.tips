import assert from 'node:assert/strict';
import {
  classifyTrafficUserAgent,
  encodeTrafficTruthSource,
  isScannerTrafficPath,
  parseTrafficTruthSource,
  projectHumanTrafficAuditRows,
  type TrafficTruthAuditRow
} from '../src/traffic-truth';
import {
  applyTrafficTruthToTelemetryRequest,
  classifyTrafficRequest,
  shouldHard404ScannerRequest
} from '../src/server/traffic-truth-request';
import { classifyBrowserTraffic } from '../src/shells/trafficTruthClient';

const humanUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';

for (const path of [
  '/.env',
  '/.env.local',
  '//wp-includes/wlwmanifest.xml',
  '/wp-login.php',
  '/wp-json/batch/v1',
  '/xmlrpc.php',
  '/.git/config',
  '/package.json',
  '/src/server/access-control.ts',
  '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
  '/%2e%2e/%2e%2e/etc/passwd'
]) {
  assert.equal(isScannerTrafficPath(path), true, `scanner path must fail closed: ${path}`);
}

for (const path of [
  '/',
  '/g/4bff1537-dafa-48fc-b42c-75304ed43906',
  '/p/dj3x',
  '/u/coreymack',
  '/robots.txt',
  '/llms.txt',
  '/.well-known/apple-app-site-association'
]) {
  assert.equal(isScannerTrafficPath(path), false, `real public path must remain reachable: ${path}`);
}

assert.equal(classifyTrafficUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)'), 'known_bot');
assert.equal(classifyTrafficUserAgent('Mozilla/5.0 (compatible; GPTBot/1.2)'), 'known_bot');
assert.equal(classifyTrafficUserAgent('CensysInspect/1.1'), 'scanner');
assert.equal(classifyTrafficUserAgent('curl/8.7.1'), 'qa_automation');
assert.equal(classifyTrafficUserAgent(humanUa), 'human_candidate');

assert.deepEqual(parseTrafficTruthSource('human_candidate:google'), {
  classification: 'human_candidate',
  source: 'google'
});
assert.equal(encodeTrafficTruthSource('known_bot', 'human_candidate:google'), 'known_bot:google');
assert.equal(encodeTrafficTruthSource('human_candidate', 'direct'), 'human_candidate:direct');
assert.ok(encodeTrafficTruthSource('human_candidate', 'x'.repeat(200)).length <= 64);
assert.deepEqual(parseTrafficTruthSource(' HUMAN_CANDIDATE:Email Campaign '), {
  classification: 'human_candidate',
  source: 'email_campaign'
});

assert.equal(classifyBrowserTraffic({ userAgent: humanUa, webdriver: false, href: 'https://app.sway.tips/', hostname: 'app.sway.tips' }), 'human_candidate');
assert.equal(classifyBrowserTraffic({ userAgent: humanUa, webdriver: true, href: 'https://app.sway.tips/', hostname: 'app.sway.tips' }), 'qa_automation');
assert.equal(classifyBrowserTraffic({ userAgent: humanUa, webdriver: false, href: 'https://app.sway.tips/?sway_qa=1', hostname: 'app.sway.tips' }), 'qa_automation');
assert.equal(classifyBrowserTraffic({ userAgent: 'Applebot/0.1', webdriver: false, href: 'https://app.sway.tips/', hostname: 'app.sway.tips' }), 'known_bot');

const humanRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': humanUa, 'x-sway-traffic-class': 'human_candidate' },
  ip: '203.0.113.10',
  body: { attribution_channel: 'google' }
};
assert.equal(applyTrafficTruthToTelemetryRequest(humanRequest as never, {}), 'human_candidate');
assert.equal(humanRequest.body.attribution_channel, 'human_candidate:google');
assert.equal(applyTrafficTruthToTelemetryRequest(humanRequest as never, {}), 'human_candidate');
assert.equal(humanRequest.body.attribution_channel, 'human_candidate:google');

const spoofedHumanRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': 'Googlebot/2.1', 'x-sway-traffic-class': 'human_candidate' },
  ip: '203.0.113.12',
  body: { attribution_channel: 'direct' }
};
assert.equal(classifyTrafficRequest(spoofedHumanRequest as never, {}), 'known_bot');

const botRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': 'Googlebot/2.1', 'x-sway-traffic-class': 'human_candidate' },
  ip: '203.0.113.11',
  body: { attribution_channel: 'human_candidate:direct' }
};
assert.equal(applyTrafficTruthToTelemetryRequest(botRequest as never, {}), 'known_bot');
assert.equal(botRequest.body.attribution_channel, 'known_bot:direct');

const qaRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalU\›ˆ	ËØ\KØ[˜[]XÜËÜÚ[	ËˆXY\œÎˆÈ	Ý\Ù\‹XYÙ[	Îˆ[X[•XHKˆ\ˆ	ÌNNLKŒLŽIËˆ›ÙNˆÈ]šX][Û—ØÚ[›™[ˆ	Ù\™XÝ	ÈBŸNÂ˜\ÜÙ\™\]X[
Û\ÜÚYžU˜Y™šXÔ™\]Y\Ý
XT™\]Y\Ý\È™]™\‹ÈÕÐVWÕQ‘’P×Õ•UÔPWÒTÎˆ	ÌNNLKŒLŽIÈJK	ÜXWØ]]ÛX][Û‰ÊNÂ˜\ÜÙ\™\]X[
\U˜Y™šXÕ]Õ[[Y]žT™\]Y\Ý
XT™\]Y\Ý\È™]™\‹ÈÕÐVWÕQ‘’P×Õ•UÔPWÒTÎˆ	ÌNNLKŒLŽIÈJK	ÜXWØ]]ÛX][Û‰ÊNÂ˜\ÜÙ\™\]X[
XT™\]Y\Ý˜›ÙK˜]šX][Û—ØÚ[›™[	ÜXWØ]]ÛX][ÛŽ™\™XÝ	ÊNÂ‚˜ÛÛœÝXSX\šÙ\”™\]Y\ÝHÂˆY]Ùˆ	ÔÔÕ	Ëˆ]ˆ	ËØ\KØ[˜[]XÜËÜÚ[	ËˆÜšYÚ[˜[\›ˆ	ËØ\KØ[˜[]XÜËÜÚ[ÜÝØ^WÜXOLIËˆXY\œÎˆÈ	Ý\Ù\‹XYÙ[	Îˆ[X[•XHKˆ\ˆ	ÌŒËŒŒLLËŒLÉËˆ›ÙNˆÈ]šX][Û—ØÚ[›™[ˆ	Ù\™XÝ	ÈBŸNÂ˜\ÜÙ\™\]X[
Û\ÜÚYžU˜Y™šXÔ™\]Y\Ý
XSX\šÙ\”™\]Y\Ý\È™]™\‹ßJK	ÜXWØ]]ÛX][Û‰ÊNÂ‚˜\ÜÙ\™\]X[
ÚÝ[\™ØØ[›™\”™\]Y\Ý
È]ˆ	ËË™[‰ËÜšYÚ[˜[\›ˆ	ËË™[‰ÈH\È™]™\ŠKYJNÂ˜\ÜÙ\™\]X[
ÚÝ[\™ØØ[›™\”™\]Y\Ý
È]ˆ	ËÙËÜ™X[\›ÛÛIËÜšYÚ[˜[\›ˆ	ËÙËÜ™X[\›ÛÛIÈH\È™]™\ŠK˜[ÙJNÂ‚™[˜Ý[Ûˆ›ÝÊˆ]™[YˆÝš[™Ëˆ[]RYˆÝš[™Ëˆ]™[\NˆÝš[™ËˆÛÝ\˜ÙNˆÝš[™È[ˆ[]U\HH	ÜÚ[ÙœšXÝ[Û‰ÂŠNˆ˜Y™šXÕ]]Y]›ÝÈÂˆ™]\›ˆÂˆ]™[Yˆ[]RYˆ[]U\Kˆ]™[\KˆY]Y]NˆÛÝ\˜ÙHOOH[ÈßHˆÈÛÝ\˜ÙHKˆÜ™X]Y]ˆ	ÌŒ‹LLNUŽŒŒŒ‰ÂˆNÂŸB‚˜ÛÛœÝ˜]Ô›ÝÜÎˆ˜Y™šXÕ]]Y]›ÝÖ×HHÂˆ›ÝÊ	Ú[X[‹Y[žIË	Ú›Ý\›™^KZ[X[‰Ë	Ü›ÛÛWÙ[žWÝšY]ÙY	Ë	Ú[X[—ØØ[™Y]N™ÛÛÙÛIÊKˆ›ÝÊ	Ú[X[‹[Ý]ÛÛYIË	Ú›Ý\›™^KZ[X[‰Ë	Ü›ÛÛWÙ[žWØÛÛ\]Y	Ë	Ù\™XÝ	ÊKˆ›ÝÊ	Ú[X[‹X\ÜÚYÛ›Y[	Ë	Ú›Ý\›™^KZ[X[‰Ë	Ù\ØÛÝ™\žWÙ^\š[Y[˜\ÜÚYÛ›Y[	Ë[
Kˆ›ÝÊ	ÜXKY[žIË	Ú›Ý\›™^K\XIË	Ü›ÛÛWÙ[žWÝšY]ÙY	Ë	ÜXWØ]]ÛX][ÛŽ™\™XÝ	ÊKˆ›ÝÊ	ÜXK[Ý]ÛÛYIË	Ú›Ý\›™^K\XIË	Ü›ÛÛWÙ[žWØÛÛ\]Y	Ë	Ù\™XÝ	ÊKˆ›ÝÊ	Ø›ÝY[žIË	Ú›Ý\›™^KX›Ý	Ë	Ù\ØÛÝ™\žWÛ[™[™ÉË	ÚÛ›ÝÛ—Ø›Ý™ÛÛÙÛIÊKˆ›ÝÊ	ÜØØ[›™\‹Y[žIË	Ú›Ý\›™^K\ØØ[›™\‰Ë	Ù\ØÛÝ™\žWÛ[™[™ÉË	ÜØØ[›™\Ž[šÛ›ÝÛ‰ÊKˆ›ÝÊ	ÛYØXÞKY[žIË	Ú›Ý\›™^K[YØXÞIË	Ù\ØÛÝ™\žWÛ[™[™ÉË	Ù\™XÝ	ÊKˆ›ÝÊ	ÝZ[YZ[X[‰Ë	Ú›Ý\›™^K]Z[Y	Ë	Ù\ØÛÝ™\žWÛ[™[™ÉË	Ú[X[—ØØ[™Y]N™\™XÝ	ÊKˆ›ÝÊ	ÝZ[Y\XIË	Ú›Ý\›™^K]Z[Y	Ë	Ü™\]Y\ÝÜÝ\Y	Ë	ÜXWØ]]ÛX][ÛŽ™\™XÝ	ÊKˆ›ÝÊ	ÛØœÙ\˜][Û‰Ë	ÛØœÙ\˜][Û‹LIË	Ù\ØÛÝ™\žWÛØœÙ\˜][Û‹œ™XÛÜ™Y	Ë	ÝÙX—ÜÙX\˜Ú	Ë	Ù\ØÛÝ™\žWÛØœÙ\˜][Û‰ÊB—NÂ‚˜ÛÛœÝ›Ú™XÝ[ÛˆH›Ú™XÝ[X[•˜Y™šXÐ]Y]›ÝÜÊ˜]Ô›ÝÜÊNÂ˜\ÜÙ\™Y\\]X[
ˆ›Ú™XÝ[Û‹œ›ÝÜË›X\

˜[YJHOˆ˜[YK™]™[Y
KœÛÜ

KˆÉÚ[X[‹X\ÜÚYÛ›Y[	Ë	Ú[X[‹Y[žIË	Ú[X[‹[Ý]ÛÛYIË	ÛØœÙ\˜][Û‰×KœÛÜ

BŠNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œ›ÝÜË™š[™

˜[YJHOˆ˜[YK™]™[YOOH	Ú[X[‹Y[žIÊOË›Y]Y]OËœÛÝ\˜ÙK	ÙÛÛÙÛIÊNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œ›ÝÜË™š[™

˜[YJHOˆ˜[YK™]™[YOOH	Ú[X[‹[Ý]ÛÛYIÊOË›Y]Y]OËœÛÝ\˜ÙK	Ù\™XÝ	ÊNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žKš[X[Ø[™Y]R›Ý\›™^\ËJNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žKšÛ›ÝÛ›Ý›Ý\›™^\ËJNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žKœØØ[›™\’›Ý\›™^\ËJNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žKœXP]]ÛX][Û’›Ý\›™^\ËŠNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žK˜]]ÛX]Y›Ý\›™^\Ñ^ÛYY
NÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žKZ[Y›Ý\›™^\Ñ^ÛYYJNÂ˜\ÜÙ\™\]X[
›Ú™XÝ[Û‹œÝ[[X\žK›YØXÞR›Ý\›™^\Ñ^ÛYYJNÂ‚˜ÛÛœÛÛK›ÙÊ	ÔÝØ^H˜Y™šXË]]™Z]š[Üˆ\ÜÙY‰ÊNÂ