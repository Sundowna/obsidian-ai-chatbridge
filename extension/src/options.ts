// The extension's options page: paste the pairing code, see the link state, unpair.

type LinkState = 'not-paired' | 'connecting' | 'linked' | 'plugin-closed' | 'refused';

const TEXT: Record<LinkState, string> = {
	'not-paired': 'Not paired',
	connecting: 'Connecting…',
	linked: 'Linked to Obsidian',
	'plugin-closed': 'Paired. Obsidian is closed or the Browser link is off there; it reconnects by itself',
	refused: 'Obsidian refused the link. Get a new pairing code and pair again',
};

const box = document.getElementById('state')!;
const text = document.getElementById('state-text')!;
const input = document.getElementById('code') as HTMLInputElement;
const pairButton = document.getElementById('pair') as HTMLButtonElement;

function show(s: LinkState): void {
	box.dataset.state = s;
	text.textContent = TEXT[s] ?? s;
}

async function ask(msg: Record<string, string>): Promise<LinkState> {
	const r = await chrome.runtime.sendMessage(msg) as { state: LinkState };
	return r.state;
}

input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairButton.click(); });

pairButton.addEventListener('click', () => {
	const code = input.value.trim();
	if (!/^\d{2,5}-[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code)) {
		text.textContent = 'That does not look like a pairing code (for example 48213-K7QF-9M2D-4XJP).';
		box.dataset.state = 'refused';
		return;
	}
	pairButton.disabled = true;
	show('connecting');
	void ask({ op: 'pair', code }).then((s) => {
		show(s);
		if (s === 'linked') input.value = '';
	}).finally(() => { pairButton.disabled = false; });
});

document.getElementById('unpair')!.addEventListener('click', () => void ask({ op: 'unpair' }).then(show));

// Site access: Chrome grants it at install; Firefox may leave it to you.
const origins = chrome.runtime.getManifest().host_permissions ?? [];
const access = document.getElementById('access')!;
async function checkAccess(): Promise<void> {
	access.hidden = await chrome.permissions.contains({ origins });
}
document.getElementById('grant')!.addEventListener('click', () => {
	void chrome.permissions.request({ origins }).then(checkAccess);
});
void checkAccess();

chrome.storage.session.onChanged.addListener((changes) => {
	const s = changes.state?.newValue as LinkState | undefined;
	if (s) show(s);
});
void ask({ op: 'state' }).then(show);
