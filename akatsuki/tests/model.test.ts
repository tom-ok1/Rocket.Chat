import { expect, it } from 'vitest';
import { messageToEvent, parseReceipt } from '../../apps/meteor/client/akatsuki/model';
const message = { _id: 'm1', rid: 'r1', msg: '北側に車両を確認', ts: '2026-10-15T01:00:00Z', u: { _id: 'u1', username: 'scout' } };
it('rejects ciphertext and sends only the decrypted message as report text', async () => {
	await expect(messageToEvent('https://chat.example', { ...message, t: 'e2e' })).rejects.toThrow('not decrypted');
	const event = await messageToEvent('https://chat.example', { ...message, t: 'e2e', e2e: 'done' });
	expect(event?.body.text).toBe('北側に車両を確認');
	expect(event?.body.sourceAsset.deviceId).toBe('rocket-chat:https://chat.example:r1');
});
it('deduplicates reactions while retaining text edits and distinct message IDs', async () => {
	const first = await messageToEvent('https://chat.example', message);
	expect((await messageToEvent('https://chat.example', { ...message, _updatedAt: new Date() }))?.key).toBe(first?.key);
	expect((await messageToEvent('https://chat.example', { ...message, msg: '訂正 南側', editedAt: '2026-10-15T01:01:00Z' }))?.key).not.toBe(
		first?.key,
	);
	expect((await messageToEvent('https://chat.example', { ...message, _id: 'm2' }))?.key).not.toBe(first?.key);
});
it('supports attachment metadata without fetching binary files', async () => {
	const event = await messageToEvent('https://chat.example', {
		...message,
		msg: '',
		files: [{ _id: 'f1', name: 'photo.jpg', type: 'image/jpeg' }],
	});
	expect(event?.body.text).toContain('photo.jpg');
});
it('requires both server receipt IDs', () => {
	expect(() => parseReceipt({ report: { id: 'rr1' } })).toThrow();
	expect(parseReceipt({ report: { id: 'rr1' }, analysisRun: { id: 'ar1' } })).toEqual({ reportId: 'rr1', analysisRunId: 'ar1' });
});

it('sends the operator message without a Rocket.Chat metadata prefix', async () => {
	const event = await messageToEvent('https://chat.example', { ...message, msg: '敵車両発見 test' });
	expect(event?.body.text).toBe('敵車両発見 test');
});
