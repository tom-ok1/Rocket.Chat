import type { ReportBody } from './model';

export const sendReport = async (endpoint: string, body: ReportBody, signal: AbortSignal): Promise<unknown> => {
	const response = await fetch(endpoint, {
		method: 'POST',
		mode: 'cors',
		credentials: 'omit',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		redirect: 'error',
	});
	if (!response.ok) throw new Error(`Akatsuki HTTP ${response.status}`);
	return response.json();
};
