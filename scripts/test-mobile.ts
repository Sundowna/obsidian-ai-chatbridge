// "Test mobile connection": reading the two answers. Synthetic answers only, shaped like what
// claude.ai, chatgpt.com and Cloudflare send. Run: npm run test:mobile

import { isChallenge, noAnswer, pageTitle, passed, readClaude, readGpt, resultText, type Answer } from '../src/mobile/probe';

let failures = 0;
function expect(label: string, ok: boolean, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
	if (!ok) failures++;
}

const JSON_TYPE = { 'content-type': 'application/json' };
const HTML_TYPE = { 'Content-Type': 'text/html; charset=UTF-8' };
const KEY = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OTAifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const CHALLENGE_PAGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
const answer = (status: number, headers: Record<string, string>, text: string): Answer => ({ status, headers, text });

// --- Cloudflare check page ---------------------------------------------------
expect('header cf-mitigated marks a check page', isChallenge(answer(403, { 'cf-mitigated': 'challenge', ...HTML_TYPE }, '')));
expect('header name in any case', isChallenge(answer(403, { 'CF-Mitigated': 'challenge' }, '')));
expect('check page without the header is found by its markers', isChallenge(answer(403, HTML_TYPE, CHALLENGE_PAGE)));
expect('a check page answered with 200 still counts', isChallenge(answer(200, HTML_TYPE, CHALLENGE_PAGE)));
expect('plain 403 JSON is no check page', !isChallenge(answer(403, JSON_TYPE, '{"error":{"type":"permission_error"}}')));
expect('JSON that only mentions the words is no check page', !isChallenge(answer(200, JSON_TYPE, '{"title":"Just a moment..."}')));
expect('an ordinary HTML page is no check page', !isChallenge(answer(200, HTML_TYPE, '<html><head><title>ChatGPT</title></head></html>')));
expect('page title is read', pageTitle(CHALLENGE_PAGE) === 'Just a moment...');
expect('a key in a page title is masked', !pageTitle(`<title>${KEY}</title>`).includes('eyJ'));

// --- claude.ai ----------------------------------------------------------------
const orgs = readClaude('Main', answer(200, JSON_TYPE, '[{"uuid":"a","name":"secret org name"},{"uuid":"b"}]'));
expect('claude: list of organizations passes', passed(orgs) && orgs.login === 'accepted' && orgs.detail === '2 organizations listed.');
expect('claude: organization names are not in the report', !resultText(orgs).includes('secret org name'));
const one = readClaude('Main', answer(200, JSON_TYPE, '[{"uuid":"a"}]'));
expect('claude: one organization, singular', one.detail === '1 organization listed.');
const expired = readClaude('Main', answer(403, JSON_TYPE, '{"type":"error","error":{"type":"permission_error","message":"Invalid authorization"}}'));
expect('claude: 403 JSON is a refused login, not a check page', !passed(expired) && expired.login === 'refused' && !expired.challenge && expired.detail.includes('permission_error'));
const blocked = readClaude('Main', answer(403, { 'cf-mitigated': 'challenge', ...HTML_TYPE }, CHALLENGE_PAGE));
expect('claude: check page fails and says so', !passed(blocked) && blocked.challenge && blocked.login === 'unclear' && blocked.contentType.startsWith('text/html'));
const odd = readClaude('Main', answer(200, JSON_TYPE, '{"unexpected":true}'));
expect('claude: 200 with another shape does not pass', !passed(odd) && odd.login === 'unclear');
const html = readClaude('Main', answer(200, HTML_TYPE, '<html><head><title>Claude</title></head></html>'));
expect('claude: an HTML page does not pass and names its title', !passed(html) && html.detail.includes('"Claude"'));

// --- chatgpt.com ----------------------------------------------------------------
const session = readGpt('Main', answer(200, JSON_TYPE, JSON.stringify({ user: { email: 'someone@example.com' }, accessToken: KEY, expires: '2027-01-01' })));
expect('chatgpt: an answer with a login key passes', passed(session) && session.login === 'accepted');
expect('chatgpt: neither key nor e-mail is in the report', !resultText(session).includes(KEY) && !resultText(session).includes('example.com'));
const loggedOut = readGpt('Main', answer(200, JSON_TYPE, '{}'));
expect('chatgpt: 200 with an empty object is a refused login', !passed(loggedOut) && loggedOut.login === 'refused');
const emptyKey = readGpt('Main', answer(200, JSON_TYPE, '{"accessToken":""}'));
expect('chatgpt: an empty key does not pass', !passed(emptyKey));
const gptBlocked = readGpt('Main', answer(403, HTML_TYPE, CHALLENGE_PAGE));
expect('chatgpt: check page fails and says so', !passed(gptBlocked) && gptBlocked.challenge);
const gpt401 = readGpt('Main', answer(401, JSON_TYPE, '{"detail":"Unauthorized"}'));
expect('chatgpt: 401 is a refused login', gpt401.login === 'refused' && !gpt401.challenge);
expect('chatgpt: missing content type is reported as none', readGpt('Main', answer(500, {}, '')).contentType === 'none');

// --- report text ----------------------------------------------------------------
const text = resultText(blocked);
expect('report names status, type and the check page', text.includes('status: 403') && text.includes('content type: text/html') && text.includes('Cloudflare check page: yes') && text.includes('FAIL'));
expect('report of a pass', resultText(orgs).startsWith('claude.ai (Main): PASS') && resultText(orgs).includes('Cloudflare check page: no'));
const skipped = noAnswer('chatgpt.com', 'https://chatgpt.com/api/auth/session', 'Work', 'Nothing pasted on this device.', false);
expect('nothing pasted is "not tested", not a failure', skipped.login === 'not tested' && resultText(skipped).startsWith('chatgpt.com (Work): NOT TESTED') && !passed(skipped));
const dead = noAnswer('claude.ai', 'https://claude.ai/api/organizations', 'Main', 'Network error: offline', true);
expect('a request without an answer fails', resultText(dead).startsWith('claude.ai (Main): FAIL') && resultText(dead).includes('offline'));

console.log(failures ? `\n${failures} FAILED` : '\nAll mobile connection tests passed.');
process.exit(failures ? 1 : 0);
