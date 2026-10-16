import { afterEach, expect, it, vi } from 'vitest';
import { sendReport } from '../../apps/meteor/client/akatsuki/transport';

afterEach(() => vi.unstubAllGlobals());

it('posts directly to the configured Akatsuki URL without browser credentials', async () => {
	const receipt = { report: { id: 'rr-1' }, analysisRun: { id: 'ar-1' } };
	const request = vi.fn().mockResolvedValue(Response.json(receipt));
	vi.stubGlobal('fetch', request);
	const body = {
		text: '報告',
		acquisition: { kind: 'manual_text' as const },
		sourceAsset: { deviceId: 'r1', category: 'unknown' as const },
	};
	const signal = new AbortController().signal;
	expect(await sendReport('https://akatsuki.example/api/reports/text', body, signal)).toEqual(receipt);
	expect(request).toHaveBeenCalledWith(
		'https://akatsuki.example/api/reports/text',
		expect.objectContaining({
			method: 'POST',
			mode: 'cors',
			credentials: 'omit',
			redirect: 'error',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: expect.any(AbortSignal),
		}),
	);
});

it('propagates HTTP and network failures so the durable outbox can retry', async () => {
	const request = vi
		.fn()
		.mockResolvedValueOnce(new Response(null, { status: 503 }))
		.mockRejectedValueOnce(new TypeError('Failed to fetch'));
	vi.stubGlobal('fetch', request);
	const body = {
		text: '報告',
		acquisition: { kind: 'manual_text' as const },
		sourceAsset: { deviceId: 'r1', category: 'unknown' as const },
	};
	const signal = new AbortController().signal;
	await expect(sendReport('https://akatsuki.example/api/reports/text', body, signal)).rejects.toThrow('503');
	await expect(sendReport('https://akatsuki.example/api/reports/text', body, signal)).rejects.toThrow('Failed to fetch');
});
