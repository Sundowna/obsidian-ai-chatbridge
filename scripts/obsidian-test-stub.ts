export class TFile {
	constructor(public path: string, public stat: { size: number }) {}
}

export class TFolder {
	children: (TFile | TFolder)[] = [];
	constructor(public path: string) {}
}

export class PluginSettingTab {}
export class Plugin {}
export class FileSystemAdapter {}
export class AbstractInputSuggest {}
export class Notice {}
export class SecretComponent {}
export class Setting {}
export class Modal {}
export class SuggestModal {}
export class TextComponent {}
export const setIcon = () => undefined;
export const normalizePath = (path: string) => path.replace(/\\/g, '/');
/** A test may answer requests itself; without it every request fails. */
export const testHooks: { requestUrl: null | ((r: { url: string; method?: string }) => Promise<unknown>) } = { requestUrl: null };
export async function requestUrl(r: { url: string; method?: string }): Promise<unknown> {
	if (testHooks.requestUrl) return testHooks.requestUrl(r);
	throw new Error('Network requests are forbidden in this test.');
}
export const getLinkpath = (linktext: string) => linktext.split('#')[0] ?? linktext;
export const Platform = { isMobile: false, isDesktop: true, isAndroidApp: false, isIosApp: false, isTablet: false };
export const apiVersion = 'test';
