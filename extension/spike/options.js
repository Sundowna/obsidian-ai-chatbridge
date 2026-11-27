const $ = (id) => document.getElementById(id);

async function show() {
	const { pairing } = await chrome.storage.local.get('pairing');
	const { status } = (await chrome.storage.session.get('status')) || {};
	$('status').textContent = pairing ? `Paired to port ${pairing.port}: ${status || 'connecting…'}` : 'Not paired';
}

$('pair').onclick = async () => {
	const m = $('code').value.trim().match(/^(\d{4,5})-([A-Za-z0-9_-]{16,})$/);
	if (!m) {
		$('status').textContent = 'That code does not look right.';
		return;
	}
	await chrome.storage.local.set({ pairing: { port: Number(m[1]), token: m[2] } });
	$('code').value = '';
	await chrome.runtime.sendMessage({ op: 'reconnect' });
	setTimeout(show, 1000);
};

$('unpair').onclick = async () => {
	await chrome.storage.local.remove('pairing');
	await chrome.runtime.sendMessage({ op: 'reconnect' });
	show();
};

chrome.storage.onChanged.addListener(show);
show();
