import type { CollectorEvent, Receipt } from './model';
import { isoDate, nonempty, object, validateEvent } from './model';

const incompatible = (): Error =>
	new Error('Akatsuki collector storage is incompatible. Back it up and explicitly delete this collector database to start over.');
const request = <T>(operation: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		operation.onsuccess = () => resolve(operation.result);
		operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'));
	});
const completed = (tx: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
		tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
	});
const validateCursor = (input: unknown): { roomId: string; coveredThrough: string } => {
	const cursor = object(input);
	return { roomId: nonempty(cursor.roomId), coveredThrough: isoDate(cursor.coveredThrough) };
};

export class CollectorStore {
	private constructor(private readonly db: IDBDatabase) {}

	static async open(name: string): Promise<CollectorStore> {
		const operation = indexedDB.open(name);
		operation.onupgradeneeded = (event) => {
			if (event.oldVersion !== 0) {
				operation.transaction?.abort();
				return;
			}
			const db = operation.result;
			db.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'schema', version: 1 });
			db.createObjectStore('cursors', { keyPath: 'roomId' });
			db.createObjectStore('events', { keyPath: 'key' }).createIndex('status', 'status', { unique: false });
		};
		const db = await request(operation);
		try {
			if (db.version !== 1 || [...db.objectStoreNames].sort().join(',') !== 'cursors,events,meta') throw incompatible();
			const tx = db.transaction(['meta', 'cursors', 'events'], 'readonly');
			const done = completed(tx);
			void done.catch(() => undefined);
			if (
				tx.objectStore('meta').keyPath !== 'key' ||
				tx.objectStore('events').keyPath !== 'key' ||
				tx.objectStore('cursors').keyPath !== 'roomId'
			)
				throw incompatible();
			const marker = await request<unknown>(tx.objectStore('meta').get('schema'));
			if (object(marker).version !== 1) throw incompatible();
			if (!tx.objectStore('events').indexNames.contains('status') || tx.objectStore('events').index('status').keyPath !== 'status')
				throw incompatible();
			await Promise.all(
				(
					[
						['cursors', validateCursor],
						['events', validateEvent],
					] as const
				).map(
					([store, validate]) =>
						new Promise<void>((resolve, reject) => {
							const scan = tx.objectStore(store).openCursor();
							scan.onerror = () => reject(scan.error);
							scan.onsuccess = () => {
								const cursor = scan.result;
								if (!cursor) {
									resolve();
									return;
								}
								try {
									validate(cursor.value);
									cursor.continue();
								} catch {
									reject(incompatible());
								}
							};
						}),
				),
			);
			await done;
			db.onversionchange = () => db.close();
			return new CollectorStore(db);
		} catch {
			db.close();
			throw incompatible();
		}
	}

	close(): void {
		this.db.close();
	}

	private async transaction<T>(
		names: string | string[],
		mode: IDBTransactionMode,
		operation: (tx: IDBTransaction) => Promise<T>,
	): Promise<T> {
		const tx = this.db.transaction(names, mode);
		const done = completed(tx);
		// The transaction may abort before the outstanding request rejects.
		void done.catch(() => undefined);
		try {
			const result = await operation(tx);
			await done;
			return result;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				/* Already completed or aborted. */
			}
			await done.catch(() => undefined);
			throw error;
		}
	}

	async cursor(roomId: string): Promise<string | null> {
		return this.transaction('cursors', 'readonly', async (tx) => {
			const value: unknown = await request(tx.objectStore('cursors').get(roomId));
			return value === undefined ? null : validateCursor(value).coveredThrough;
		});
	}

	async initialize(roomId: string, since: string): Promise<void> {
		const value = { roomId: nonempty(roomId), coveredThrough: isoDate(since) };
		await this.transaction('cursors', 'readwrite', async (tx) => {
			if ((await request(tx.objectStore('cursors').get(roomId))) === undefined) tx.objectStore('cursors').add(value);
		});
	}

	async cover(roomId: string, through: string): Promise<void> {
		const timestamp = isoDate(through);
		await this.transaction('cursors', 'readwrite', async (tx) => {
			const current: unknown = await request(tx.objectStore('cursors').get(roomId));
			if (current === undefined || timestamp < validateCursor(current).coveredThrough)
				throw new Error('Cursor cannot move backwards or skip initialization');
			tx.objectStore('cursors').put({ roomId, coveredThrough: timestamp });
		});
	}

	async enqueue(events: readonly CollectorEvent[]): Promise<void> {
		const validated = events.map(validateEvent);
		await this.transaction('events', 'readwrite', async (tx) => {
			for (const event of validated) {
				// eslint-disable-next-line no-await-in-loop -- Reads and inserts share one transaction so repeated keys in a batch deduplicate.
				if ((await request(tx.objectStore('events').get(event.key))) === undefined) tx.objectStore('events').add(event);
			}
		});
	}

	async pending(): Promise<CollectorEvent[]> {
		return this.transaction('events', 'readonly', async (tx) => {
			const values: unknown[] = await request(tx.objectStore('events').index('status').getAll('pending', 20));
			return values.map(validateEvent);
		});
	}

	async acknowledge(key: string, receipt: Receipt): Promise<void> {
		await this.transaction('events', 'readwrite', async (tx) => {
			const value: unknown = await request(tx.objectStore('events').get(key));
			if (value === undefined) throw new Error('Unknown outbox event');
			tx.objectStore('events').put(validateEvent({ ...validateEvent(value), status: 'accepted', receipt }));
		});
	}
}
