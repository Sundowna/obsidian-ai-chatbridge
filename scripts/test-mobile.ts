// "Test mobile connection": reading the two answers. Synthetic answers only, shaped like what
// claude.ai, chatgpt.com and Cloudflare send. Run: npm run test:mobile

import { browserLoginSecretId, browserLoginText, checkBrowserLogin, SESSION_COOKIE_NAME } from '../src/chatgpt/browser-login';
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

// --- "Use browser login" (ChatGPT accounts made with Google, issue #52) ------
void (async () => {
	const TOKEN = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aGVsbG8td29ybGQtc2Vzc2lvbi10b2tlbg';
	const asked: string[] = [];
	const probe = (a: Answer | Error) => async (cookie: string) => {
		asked.push(cookie);
		if (a instanceof Error) throw a;
		return a;
	};
	const ok = answer(200, JSON_TYPE, JSON.stringify({ accessToken: KEY, user: { id: 'user-1' } }));
	expect('browser login: empty paste is not sent', (await checkBrowserLogin('   ', probe(ok))).kind === 'empty' && asked.length === 0);
	const bad = await checkBrowserLogin('hello there', probe(ok));
	expect('browser login: a wrong paste names the cookie to copy and is not sent', bad.kind === 'malformed' && bad.message.includes(SESSION_COOKIE_NAME) && asked.length === 0);
	const works = await checkBrowserLogin(`  ${TOKEN}  `, probe(ok));
	expect('browser login: a bare value is sent as the session cookie and works', works.kind === 'works' && asked.at(-1) === `${SESSION_COOKIE_NAME}=${TOKEN}`, works.message);
	const split = `Cookie: oai-did=abc; ${SESSION_COOKIE_NAME}.0=${TOKEN}; ${SESSION_COOKIE_NAME}.1=${TOKEN}`;
	expect('browser login: a whole Cookie line with .0 and .1 works', (await checkBrowserLogin(split, probe(ok))).kind === 'works' && asked.at(-1)!.includes(`${SESSION_COOKIE_NAME}.1=`));
	const refused = await checkBrowserLogin(TOKEN, probe(answer(200, JSON_TYPE, '{}')));
	expect('browser login: an expired cookie is refused, says what to do, saves nothing', refused.kind === 'refused' && refused.message.includes('Nothing was saved') && refused.message.includes('copy it again'));
	expect('browser login: a refused single value asks for the .1 value first', refused.message.includes('.1 value in the second box'));
	const bothRefused = await checkBrowserLogin(browserLoginText(TOKEN, TOKEN), probe(answer(200, JSON_TYPE, '{}')));
	expect('browser login: refused with both values says to copy both again', bothRefused.kind === 'refused' && bothRefused.message.includes('copy both values again') && !bothRefused.message.includes(TOKEN));
	expect('browser login: one box gives the bare value', browserLoginText(`  ${TOKEN} `, '  ') === TOKEN);
	const joined = browserLoginText(TOKEN, ' tail-part ');
	expect('browser login: two boxes give the .0 and .1 cookie', joined === `${SESSION_COOKIE_NAME}.0=${TOKEN}; ${SESSION_COOKIE_NAME}.1=tail-part`);
	expect('browser login: the two-box text is sent as both parts and works', (await checkBrowserLogin(joined, probe(ok))).kind === 'works' && asked.at(-1) === joined);
	expect('browser login: only the second box filled counts as empty', browserLoginText('', TOKEN) === '');
	expect('browser login: a 401 is refused', (await checkBrowserLogin(TOKEN, probe(answer(401, JSON_TYPE, '{}')))).kind === 'refused');
	const cf = await checkBrowserLogin(TOKEN, probe(answer(403, { 'cf-mitigated': 'challenge', ...HTML_TYPE }, CHALLENGE_PAGE)));
	expect('browser login: a Cloudflare check is "unclear", not saved', cf.kind === 'unclear' && cf.message.includes('Cloudflare'));
	const offline = await checkBrowserLogin(TOKEN, probe(new Error('Network error: offline')));
	expect('browser login: no connection is "unclear", not saved', offline.kind === 'unclear' && offline.message.includes('offline') && !offline.message.includes(TOKEN));
	const odd = await checkBrowserLogin(TOKEN, probe(answer(500, HTML_TYPE, '<html></html>')));
	expect('browser login: an odd answer is "unclear" and names the status', odd.kind === 'unclear' && odd.message.includes('500'));
	expect('browser login: no message ever holds the pasted value', [bad, works, refused, cf, offline, odd].every((r) => !r.message.includes(TOKEN)));
	expect('browser login: a new account gets its own valid secret ID', browserLoginSecretId('', 'Agri_Land 2') === 'ai-chatbridge-chatgpt-agri-land-2' && /^[a-z0-9-]+$/.test(browserLoginSecretId('', '__')));
	expect('browser login: a secret the account already names is reused', browserLoginSecretId('my-gpt-cookie', 'x') === 'my-gpt-cookie');

	console.log(failures ? `\n${failures} FAILED` : '\nAll mobile connection tests passed.');
	process.exit(failures ? 1 : 0);
})();
