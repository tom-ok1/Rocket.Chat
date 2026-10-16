import { expect, it, vi } from 'vitest';

// Isolate Meteor UI/services; use the official room implementation and real Web Crypto.
vi.mock('../../apps/meteor/client/lib/e2ee/logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('../../apps/meteor/client/lib/e2ee/rocketchat.e2e', () => ({ e2e: {} }));
vi.mock('../../apps/meteor/app/utils/client/lib/SDKClient', () => ({ sdk: {} }));
vi.mock('../../apps/meteor/app/utils/lib/i18n', () => ({ t: (key) => key }));
vi.mock('../../apps/meteor/definition/IRoomTypeConfig', () => ({ RoomSettingsEnum: {} }));
vi.mock('../../apps/meteor/client/stores', () => ({ Messages: {}, Rooms: {}, Subscriptions: {} }));
vi.mock('../../apps/meteor/client/lib/RoomManager', () => ({ RoomManager: {} }));
vi.mock('../../apps/meteor/client/lib/rooms/roomCoordinator', () => ({ roomCoordinator: {} }));

import { E2ERoom } from '../../apps/meteor/client/lib/e2ee/rocketchat.e2e.room';
import { generateAESKey } from '../../apps/meteor/client/lib/e2ee/helper';

const roomWithKey = async () => {
	const room = Object.create(E2ERoom.prototype);
	room.groupSessionKey = await generateAESKey();
	room.keyID = 'test-key-001';
	return room;
};

it('strict mode throws on invalid AES keys instead of returning display-only error text', async () => {
	const sender = await roomWithKey();
	const receiver = await roomWithKey();
	const message = await sender.encryptMessage({ _id: 'm1', rid: 'r1', msg: 'secret report' });
	await expect(receiver.decryptMessage(structuredClone(message), { throwOnError: true })).rejects.toThrow();
	const display = await receiver.decryptMessage(structuredClone(message));
	expect(display.e2e).toBe('done');
	expect(display.msg).toBe('E2E_Key_Error');
});

it('strict mode restores real ciphertext even if another listener has marked the object done', async () => {
	const room = await roomWithKey();
	const message = await room.encryptMessage({ _id: 'm1', rid: 'r1', msg: 'secret report' });
	const decrypted = await room.decryptMessage({ ...message, e2e: 'done', msg: 'display-only fallback' }, { throwOnError: true });
	expect(decrypted.msg).toBe('secret report');
});

it('strict mode rejects missing room keys and unsupported encrypted payloads', async () => {
	const sender = await roomWithKey();
	const message = await sender.encryptMessage({ _id: 'm1', rid: 'r1', msg: 'secret report' });
	const receiver = Object.create(E2ERoom.prototype);
	await expect(receiver.decryptMessage(structuredClone(message), { throwOnError: true })).rejects.toThrow();
	await expect(
		sender.decryptMessage({ ...message, content: { algorithm: 'unsupported', ciphertext: 'invalid' } }, { throwOnError: true }),
	).rejects.toThrow();
});
