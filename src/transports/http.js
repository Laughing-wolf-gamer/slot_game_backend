import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { assert, errorBody } from '../common/errors.js';
import { envelope } from '../common/validation.js';
import { createConsoleLogger } from '../common/logging.js';
import { requireRole } from '../common/auth.js';
import { id } from '../common/validation.js';
import Machine from '../models/machine.js';
import Audit from '../models/audit.js';
import Device from '../models/device.js';
import Presence from '../models/presence.js';
import { clean, remaining } from '../modules/backend.js';
import { z } from 'zod';
import mongoose from 'mongoose';

const logger = createConsoleLogger();
export function createHttp({ config, database, auth, backend }) {
	const app = express();
	app.disable('x-powered-by');
	app.use(helmet());

	app.use(cors({ origin: config.origins }));

	app.use(express.json({ limit: '128kb' }));
	app.use('/api', rateLimit({
		windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false 
	}));
	app.get('/health/live', (_req, res) => res.json({
		status: 'UP'
	
	}));

	app.get('/health/ready', async (_req, res) => {
		try {
			await database.db.command({ ping: 1 });
			res.json({ status: 'READY' });

		} catch {
			res.status(503).json({ status: 'DATABASE_UNAVAILABLE' }); 
		}
	});
	const loginLimit = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
	for (const action of ['login', 'refresh', 'logout']) {
		app.post(`/api/v1/auth/${action}`, async (req, res) => res.json({
			ok: true,
			data: await auth[action](req.body)
			
		}));
	}
	for (const [path, operation] of [['verify-password', 'verifyPassword'], ['change-password', 'changePassword']]) {
		app.post(`/api/v1/auth/${path}`, loginLimit, async (req, res) => {
			const actor = await auth.access(req.headers.authorization?.replace(/^Bearer /, ''));
			res.json({ ok: true, data: await auth[operation](actor, req.body) });
		});
	}
	const router = express.Router({ mergeParams: true });
	router.use(async (req, _res, next) => {
		req.actor = await auth.access(req.headers.authorization?.replace(/^Bearer /, ''));
		
		assert(req.actor.storeId === req.params.storeId, 'FORBIDDEN', 'Store scope mismatch', 403);
		next();
	});
	async function getters(path, kind) {
		logger.info({path,kind},"getting api,");
		router.get(path, async (req, res) => {
			const data = await backend.query(req.actor, kind, { ...req.query, ...req.params });
			await Audit.insertOne({
				storeId: req.actor.storeId,
				actorId: req.actor.actorId, action: 'admin.read',
				category: kind, machineId: req.params.machineId, cardId: req.params.cardId, success: true });
			res.json({ ok: true, data });
		});
	}

	function setters(method, path, eventName) {
		router[method](path, async (req, res) => {
			logger.info(req.body,"req.body: ")
			const { eventId, correlationId, ...payload } = req.body || {};
			for (const key of ['gameId', 'machineId', 'cardId', 'kioskId']) {
				if (req.params[key]) payload[key] = req.params[key];
			
			}
			const event = envelope({ eventId: eventId || req.headers['idempotency-key'], correlationId, payload }, eventName, req.actor);
			const respData = await backend.dispatch(req.actor, event);
			res.json(respData);

			
		});
	}
	getters('/dashboard', 'dashboard');
	getters('/setup', 'setup');
	getters('/environment', 'environment');
	getters('/usage-fees', 'fees');
	getters('/jackpot-settings', 'totalJackpot');
	getters('/histories/:category', 'histories');
	getters('/machines/:machineId/games/:gameId/settings', 'machineSettings');
	getters('/machines', 'machines');
	getters('/machines/:machineId/history', 'ledger');
	getters('/games', 'games');
	getters('/games/:gameId/settings', 'settings');
	getters('/games/:gameId/pools', 'pools');
	
	getters('/games/:gameId/sessions', 'sessions');
	getters('/cards', 'cards');
	getters('/cards/:cardId/ledger', 'ledger');
	
	getters('/audit', 'audit');
	getters('/settlements/current', 'settlements');
	getters('/settlements/history', 'history');
	
	getters('/machines/:machineId/commands', 'commands');
	setters('put', '/games/:gameId/settings', 'game.settings.update.v1');
	setters('post', '/cards', 'card.create.v1');
	
	setters('post', '/cards/:cardId/adjustments', 'card.adjust.v1');
	setters('post', '/settlements/close', 'settlement.close.v1'); 
	setters('post', '/machines/:machineId/commands', 'command.request.v1');

	for (const action of ['paid', 'service', 'maintenance']){
		
		setters('post', `/machines/:machineId/time/${action}`, `time.add.${action}.v1`);
		
	}
	for (const action of ['pause', 'resume', 'delete']) {
	
		setters('post', `/machines/:machineId/time/${action}`, `time.${action}.v1`);
	}
	setters('post', '/games/:gameId/jackpots', 'game.jackpot.reserve.v1');
	setters('post', '/games', 'registry.game.create.v1');
	setters('post', '/machines', 'registry.machine.create.v1');
	setters('post', '/devices', 'registry.device.create.v1');
	setters('post', '/devices/revoke', 'registry.device.revoke.v1');
	setters('post', '/users', 'registry.user.create.v1');
	setters('post', '/cards/validate', 'card.validate.v1');
	setters('patch', '/cards/:cardId', 'card.update.v1');
	setters('post', '/cards/:cardId/reset', 'card.reset.v1');
	setters('delete', '/cards/:cardId', 'card.delete.v1');
	setters('delete', '/admin-cards/:cardId', 'admin-card.delete.v1');
	setters('put', '/environment', 'store.environment.update.v1');
	setters('put', '/usage-fees', 'store.fees.update.v1');
	setters('put', '/jackpot-settings', 'store.jackpots.update.v1');
	setters('post', '/jackpot-settings/reset', 'store.jackpots.reset.v1');
	setters('put', '/passwords', 'store.password.update.v1');
	setters('post', '/passwords/verify', 'store.password.verify.v1');
	setters('post', '/histories/reset', 'history.reset.v1');
	setters('post', '/activities', 'activity.record.v1');
	setters('patch', '/machines/:machineId', 'registry.machine.update.v1');
	setters('delete', '/machines/:machineId', 'registry.machine.delete.v1');
	setters('put', '/machines/:machineId/status', 'machine.status.update.v1');
	setters('post', '/machines/:machineId/reset', 'machine.reset.v1');
	setters('post', '/machines/:machineId/time/start', 'time.session.start.v1');
	setters('put', '/machines/:machineId/games/:gameId/settings', 'machine.settings.update.v1');
	setters('post', '/machines/:machineId/games/:gameId/settings/reset', 'machine.settings.reset.v1');
	setters('post', '/games/:gameId/settings/reset', 'game.settings.reset.v1');
	setters('post', '/kiosks/:kioskId/reset', 'kiosk.reset.v1');

	const hq = express.Router();
	
	hq.use(async (req, _res, next) => {

		req.actor = await auth.access(req.headers.authorization?.replace(/^Bearer /, ''));
		requireRole(req.actor, ['HQ_SUPER_ADMIN']);
		next();
	});
	hq.get('/machines', async (req, res) => {

		const filter = req.query.storeId ? {
			storeId: id.parse(req.query.storeId) 
		} : {};
		if (req.query.cursor) {
			filter._id = { $lt: new mongoose.Types.ObjectId(z.string().regex(/^[a-f0-9]{24}$/i).parse(req.query.cursor)) };
		}
		const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
		const machines = await Machine.find(filter).sort({ _id: -1 }).limit(limit).lean();
		const machineScopes = machines.map(m => ({ storeId: m.storeId, machineId: m.machineId }));
		const devices = machineScopes.length ? await Device.find({ $or: machineScopes, role: 'DEVICE_TAS_C' }).lean() : [];
		const presence = machineScopes.length ? await Presence.find({ $or: machineScopes, connected: true,
			lastSeenAt: { $gt: new Date(Date.now() - 30000) }, role: 'DEVICE_TAS_C' }).lean() : [];
		res.json({
			ok: true,
			nextCursor: machines.length === limit ? String(machines.at(-1)._id) : null,
			data: clean(machines.map(m => ({ ...m, remainingSeconds: remaining(m),
			agent: devices.find(d => d.storeId === m.storeId && d.machineId === m.machineId),
			connected: presence.some(p => p.storeId === m.storeId && p.machineId === m.machineId) }))) });
	});
	hq.get('/activity', async (req, res) => {
		const filter = req.query.storeId ? { storeId: id.parse(req.query.storeId) } : {};
		if (req.query.cursor) {
			filter._id = {
				$lt: new mongoose.Types.ObjectId(z.string().regex(/^[a-f0-9]{24}$/i).parse(req.query.cursor)) 
			
			};
		}
		const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
		const records = await Audit.find(filter).sort({ _id: -1 }).limit(limit).lean();
		res.json({ ok: true, nextCursor: records.length === limit ? String(records.at(-1)._id) : null, data: clean(records) });
	});
	for (const [method, path, eventName] of [['post', '/stores/:storeId/machines', 'registry.machine.create.v1'],
		['patch', '/stores/:storeId/machines/:machineId', 'registry.machine.update.v1'],
		['delete', '/stores/:storeId/machines/:machineId', 'registry.machine.delete.v1'],
		['post', '/stores/:storeId/devices', 'registry.device.create.v1']]) {
			
		hq[method](path, async (req, res) => {
			const actor = { ...req.actor, storeId: id.parse(req.params.storeId) };
			const { eventId, correlationId, ...payload } = req.body || {};
			if (req.params.machineId) payload.machineId = req.params.machineId;
			res.json(await backend.dispatch(actor, envelope({ eventId: eventId || req.headers['idempotency-key'], correlationId, payload }, eventName, actor)));
		});
	}
	app.use('/api/v1/hq', hq);

	app.use('/api/v1/stores/:storeId', router);
	app.use((_req, res) => res.status(404).json({

		ok: false,
		error: {

			code: 'NOT_FOUND',
			message: 'Endpoint not found'
		} 
	}));
	app.use((error, _req, res, _next) => {
		if (!error.code && error.name !== 'ZodError') {

			logger.error({ err: error }, 'HTTP request failed');
		
		}
		const malformed = error.type === 'entity.parse.failed';
		res.status(malformed ? 400 : error.status || (error.name === 'ZodError' ? 400 : 500)).json({
			ok: false,
			error: malformed ? {
				code: 'INVALID_PAYLOAD',
				message: 'Invalid JSON'
			} : errorBody(error) 
		});
	});

	return app;
}
