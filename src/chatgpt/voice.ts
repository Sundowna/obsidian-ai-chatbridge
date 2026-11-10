// Voice chats (seen 2026-11-10): a spoken message is a multimodal_text whose parts mix an
// audio pointer (audio_asset_pointer, or real_time_user_audio_video_asset_pointer for
// your side of a live voice chat) with audio_transcription parts { text, direction: in|out }.
// The audio itself is not downloaded; the raw JSON keeps the pointers.

import type { GptPart } from './types';

export const NO_TRANSCRIPTION = '*[voice message – no transcription available]*';

const AUDIO_POINTERS = new Set(['audio_asset_pointer', 'real_time_user_audio_video_asset_pointer']);

export function isAudioPointer(p: GptPart): boolean {
	return typeof p.content_type === 'string' && AUDIO_POINTERS.has(p.content_type);
}

export function isTranscription(p: GptPart): boolean {
	return p.content_type === 'audio_transcription';
}

function nonEmpty(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

/** The words of an audio_transcription part, or null when it has none. */
export function transcriptionText(p: GptPart): string | null {
	return isTranscription(p) ? nonEmpty(p.text) : null;
}

/** A transcription stored on the audio pointer itself (metadata.transcription), if any. */
export function pointerTranscription(p: GptPart): string | null {
	const audio = p.content_type === 'audio_asset_pointer' ? p : p.audio_asset_pointer;
	const metadata = audio !== null && typeof audio === 'object' ? (audio as { metadata?: unknown }).metadata : undefined;
	return metadata !== null && typeof metadata === 'object' ? nonEmpty((metadata as { transcription?: unknown }).transcription) : null;
}

/** A live voice chat with the camera on also points to video frames. */
export function hasVideo(p: GptPart): boolean {
	return (Array.isArray(p.frames_asset_pointers) && p.frames_asset_pointers.length > 0)
		|| (p.video_container_asset_pointer !== null && p.video_container_asset_pointer !== undefined);
}
