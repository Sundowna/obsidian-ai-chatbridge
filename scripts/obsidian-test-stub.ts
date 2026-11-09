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
export class TextComponent {}
export const setIcon = () => undefined;
export const normalizePath = (path: string) => path.replace(/\\/g, '/');
export async function requestUrl(): Promise<never> {
	throw new Error('Network requests are forbidden in this test.');
}
