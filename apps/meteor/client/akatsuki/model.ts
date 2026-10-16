export type SourceAsset = { deviceId: string; category: 'unknown' };
export type ReportBody = { text: string; acquisition: { kind: 'manual_text' }; sourceAsset: SourceAsset };
export type Receipt = { reportId: string; analysisRunId: string };
export type CollectorEvent = { key: string; roomId: string; body: ReportBody; status: 'pending' | 'accepted'; receipt: Receipt | null };
export type Room = { id: string; type: 'c' | 'p' | 'd' };

export const object = (input: unknown): Record<string, unknown> => {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected an object');
	return input as Record<string, unknown>;
};
export const nonempty = (input: unknown): string => {
	if (typeof input !== 'string' || input.trim() === '') throw new Error('Expected a nonempty string');
	return input;
};
export const isoDate = (input: unknown): string => {
	const date = input instanceof Date ? input : new Date(nonempty(input));
	if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
	return date.toISOString();
};
export const sha256 = async (input: string): Promise<string> => {
	const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
export const parseReceipt = (input: unknown): Receipt => {
	const reply = object(input);
	return { reportId: nonempty(object(reply.report).id), analysisRunId: nonempty(object(reply.analysisRun).id) };
};
export const validateEvent = (input: unknown): CollectorEvent => {
	const event = object(input);
	const body = object(event.body);
	const asset = object(body.sourceAsset);
	if (object(body.acquisition).kind !== 'manual_text' || asset.category !== 'unknown') throw new Error('Invalid report body');
	if (event.status !== 'pending' && event.status !== 'accepted') throw new Error('Invalid outbox status');
	let receipt: Receipt | null = null;
	if (event.status === 'accepted') {
		const saved = object(event.receipt);
		receipt = { reportId: nonempty(saved.reportId), analysisRunId: nonempty(saved.analysisRunId) };
	} else if (event.receipt !== null) throw new Error('Pending event cannot have a receipt');
	return {
		key: nonempty(event.key),
		roomId: nonempty(event.roomId),
		status: event.status,
		receipt,
		body: {
			text: nonempty(body.text),
			acquisition: { kind: 'manual_text' },
			sourceAsset: { deviceId: nonempty(asset.deviceId), category: 'unknown' },
		},
	};
};

export const messageToEvent = async (workspace: string, input: unknown): Promise<CollectorEvent | null> => {
	const message = object(input);
	if (message.t === 'e2e' && message.e2e !== 'done') throw new Error('E2EE message is not decrypted');
	// Membership and other system events are not operational reports.
	if (message.t && message.t !== 'e2e') return null;
	const text = typeof message.msg === 'string' ? message.msg.trim() : '';
	const attachments = Array.isArray(message.attachments)
		? message.attachments.map((input) => {
				const attachment = object(input);
				return { title: attachment.title, description: attachment.description, link: attachment.title_link };
			})
		: [];
	const files = Array.isArray(message.files)
		? message.files.map((input) => {
				const file = object(input);
				return { id: file._id, name: file.name, type: file.type };
			})
		: [];
	if (!text && !attachments.length && !files.length) return null;
	const roomId = nonempty(message.rid);
	const messageId = nonempty(message._id);
	const author = object(message.u);
	const provenance = {
		workspace,
		roomId,
		messageId,
		authorId: nonempty(author._id),
		username: author.username,
		postedAt: isoDate(message.ts),
		editedAt: message.editedAt ? isoDate(message.editedAt) : undefined,
		threadId: message.tmid,
		attachments,
		files,
	};
	// Reactions change _updatedAt; only report content and edit identity affect deduplication.
	const key = await sha256(
		JSON.stringify([workspace, roomId, messageId, provenance.authorId, provenance.editedAt, text, attachments, files]),
	);
	return {
		key,
		roomId,
		status: 'pending',
		receipt: null,
		body: {
			text: text || `[添付ファイル情報] ${JSON.stringify({ attachments, files })}`,
			acquisition: { kind: 'manual_text' },
			sourceAsset: { deviceId: `rocket-chat:${workspace}:${roomId}`, category: 'unknown' },
		},
	};
};
