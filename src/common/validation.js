import { z } from 'zod';
import { assert } from './errors.js';

export const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const money = z.number().int().min(0).max(1_000_000_000_000);
export const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const reason = z.string().trim().min(3).max(500);

export const settingsSchema = z.object({
	smallJackpot: z.object({ percentageBps: z.number().int().min(0).max(10000) }).strict(),
	mediumJackpot: z.object({ percentageBps: z.number().int().min(0).max(10000) }).strict(),
	bigJackpot: z.object({ percentageBps: z.number().int().min(0).max(10000) }).strict(),
	normalWinning: z.object({ percentageBps: z.number().int().min(0).max(10000) }).strict(),
	rtp: z.object({ targetBps: z.number().int().min(0).max(10000) }).strict(),
	commission: z.object({ enabled: z.boolean(), percentageBps: z.number().int().min(0).max(10000) }).strict(),
	network: z.object({ contributionPerMinute: money, threshold: money.refine(x => x > 0) }).strict()

}).strict().refine(x => 
	x.smallJackpot.percentageBps + x.mediumJackpot.percentageBps + x.bigJackpot.percentageBps === 10000, 
	'Jackpot allocations must total 10000 basis points'

);

export const defaultSettings = {
	smallJackpot: { percentageBps: 9500 }, mediumJackpot: { percentageBps: 450 }, bigJackpot: { percentageBps: 50 },
	normalWinning: { percentageBps: 8000 }, rtp: { targetBps: 9500 },
	commission: { enabled: false, percentageBps: 0 }, network: { contributionPerMinute: 0, threshold: 10000 }
};
export function safeAdd(a, b) {
	const result = a + b;
	assert(Number.isSafeInteger(result) && 
		result >= 0 && 
		result <= 1_000_000_000_000,
		'INVALID_PAYLOAD', 'Balance or counter exceeds supported range');
	return result;
}
export function bps(amount, points) {

	return Number(BigInt(amount) * BigInt(points) / 10000n); 
}


export function envelope(input, eventName, actor) {
	if (typeof input === 'string') {
		input = JSON.parse(input);
	
	}
	if (input?.message !== undefined) {
		input = typeof input.message === 'string' ? JSON.parse(input.message) : input.message;
	
	}
	const parsed = z.object({
		schemaVersion: z.literal(1).optional(), eventId: id, eventName: z.string().optional(),
		storeId: id.optional(), gameId: id.optional(), machineId: id.optional(), installationId: id.optional(),
		sessionId: id.optional(), sequence: z.number().int().positive().optional(),
		correlationId: id.optional(), payload: z.record(z.string(), z.unknown()).optional()
	}).passthrough().parse(input);
	for (const field of ['storeId', 'gameId', 'machineId', 'installationId']) {
		if (actor[field] && parsed[field]) assert(actor[field] === parsed[field], 'FORBIDDEN', `Mismatched ${field}`, 403);
	}
	const payload = parsed.payload || Object.fromEntries(Object.entries(parsed).filter(([k]) =>
		!['schemaVersion',
		'eventId',
		'eventName',
		'sequence',
		'correlationId',
		'storeId',
		'gameId',
		'machineId',
		'installationId'
	].includes(k)));
	if (parsed.sessionId && !payload.sessionId) {
		payload.sessionId = parsed.sessionId;
	
	}
	return {
		eventId: parsed.eventId,
		eventName,
		sequence: parsed.sequence,
		correlationId: parsed.correlationId || parsed.eventId,
		payload 
	};
}
