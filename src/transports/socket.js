import { z } from 'zod';
import { assert, errorBody } from '../common/errors.js';
import { envelope } from '../common/validation.js';
import { normalizeLegacyGameUpdate } from './legacy-game-update.js';
import { clean, remaining, room, uid } from '../modules/backend.js';
import { createConsoleLogger } from '../common/logging.js';
import Award from '../models/award.js';
import Command from '../models/command.js';
import Machine from '../models/machine.js';
import Presence from '../models/presence.js';
import GameSession from '../models/session.js';

const logger = createConsoleLogger();

export const legacyEvents = {
	game_started: ['game.session.start.v1', 'game_started'],
	update_game: ['game.state.update.v1', null],
	player_jackpot_send: ['game.jackpot.progress.v1', null],
	exit_game: ['game.session.exit.v1', null],
	get_in_room_players_count: ['game.settings.lock-status.v1', 'get_in_room_players_count'],
	get_game_settings_data: ['game.settings.get.v1', 'get_game_settings_data'],
	update_game_settings_data: ['game.settings.update.v1', 'update_game_settings_data'],
	game_info: ['game.pool.summary.get.v1', 'game_info'],
	test_jackpot: ['game.jackpot.test.v1', null]
};
const canonical = [
	'game.session.start.v1',
	'game.state.update.v1',
    'game.state.restore.legacy.v1',
	'game.session.exit.v1',
	'game.session.snapshot.get.v1', 'game.credit.deposit.v1', 'game.settings.get.v1',
	'game.settings.lock-status.v1', 'game.settings.update.v1', 'game.pool.summary.get.v1',
	'game.jackpot.progress.v1', 'game.jackpot.test.v1', 'game.jackpot.reserve.v1', 'game.jackpot.check.v1',
	'card.create.v1', 'card.validate.v1', 'card.adjust.v1', 'kiosk.topup.requested.v1',
	'time.session.start.v1', 'time.add.paid.v1', 'time.add.service.v1', 'time.add.maintenance.v1',
	'time.pause.v1', 'time.resume.v1', 'time.delete.v1', 'time.snapshot.get.v1',
	'command.request.v1', 'command.ack.v1', 'command.result.v1', 'settlement.close.v1'];

export function attachSockets(io, { auth, backend }) {
	const validationErrors = [
		'ZodError',
		'ValidationError',
		'CastError'
	];
	const failureDetails = error => ({

		code: errorBody(error).code, message: errorBody(error).message, errorType: error.name,
		validationIssues: error.name === 'ZodError' ? error.issues?.map(issue => ({ path: issue.path.join('.'), code: issue.code }))
			: error.name === 'ValidationError' ? Object.values(error.errors).map(issue => ({ path: issue.path, code: issue.kind }))
			: error.name === 'CastError' ? [{
				path: error.path,
				code: error.kind
			
			}] : null,
		stack: !error.code &&
			!validationErrors.includes(error.name) ? error.stack?.split('\n').slice(1).join('\n') : undefined
	});
	io.engine.on('connection_error', error => {
		logger.warn({
			stage: 'transport.handshake',
			code: error.code,
			message: error.message
		
		}, 'Socket transport handshake rejected');
	});
	const namespaces = { '/admin': null, '/agent': 'DEVICE_TAS_C', '/game': 'GAME_CLIENT', '/kiosk': 'DEVICE_TAS_K' };
	for (const [name, role] of Object.entries(namespaces)) {
		const ns = io.of(name);
		ns.use(async (socket, next) => {
			logger.info({ stage: 'authentication.start', credentialSource: socket.conn.protocol === 3 ? 'query' : 'auth' }, 'Socket authentication started');
			try {

				const credentials = socket.conn.protocol === 3 ? socket.handshake.query : socket.handshake.auth;
				logger.info(credentials,"connectd socket");
				socket.data = socket.data || {};
				socket.data.actor = role ? await auth.device(credentials, role) : await auth.access(socket.handshake.auth?.token);
				const actor = socket.data.actor;
				logger.info({ stage: 'authentication.complete', actorId: actor.actorId, storeId: actor.storeId, role: actor.role }, 'Socket authentication succeeded');
				next();
			} catch (error) {
				logger.warn({ stage: 'authentication.failed', ...failureDetails(error) }, 'Socket authentication rejected');
				const failure = new Error(errorBody(error).message);
				failure.data = errorBody(error); next(failure); 
			}
		});
		ns.on('connection', socket => {
			const socketActor = socket.data.actor;
			logger.info({
				socketId: socket.id,
				namespace: name,
				actorId: socketActor.actorId,
				storeId: socketActor.storeId,
				machineId: socketActor.machineId,
				gameId: socketActor.gameId,
				installationId: socketActor.installationId,
				stage: 'connection.accepted'
			
			}, 'Socket namespace connected');
			let initializationStage = 'rooms';
			let closing = false;
			let tokens = 60; let resetAt = Date.now() + 1000;
			const store = { storeId: socketActor.storeId };
			const scope = { ...store, socketId: socket.id };
			async function presence(connected) {
				if (closing && connected) {
					return;
				
				}
				await Presence.updateOne(scope, { $set: { actorId: socketActor.actorId, sourceId: socketActor.sourceId,
				role: socketActor.role, machineId: socketActor.machineId, gameId: socketActor.gameId, installationId: socketActor.installationId,
				connected, lastSeenAt: new Date() }, $setOnInsert: { dataId: uid(), createdAt: new Date() } }, { upsert: true });
				io.of('/admin').to(room.admins(socketActor)).emit('device.status.changed.v1', { actorId: socketActor.actorId, machineId: socketActor.machineId, connected });
			}
			async function authorized() {
				if (Date.now() > resetAt) {
					tokens = 60;
				
					resetAt = Date.now() + 1000; 
				}
				assert(tokens-- > 0, 'RATE_LIMITED', 'Too many socket events', 429);
				if (role) await auth.activeDevice(socketActor);
				else await auth.access(socket.handshake.auth.token);
			}
			async function initialize() {
				logger.info({ stage: 'initialization.start' }, 'Socket initialization started');
				if (name === '/admin') {
				
					socket.join(room.admins(socketActor));
				}
				
				if (name === '/agent') {
					socket.join(room.machine(socketActor));
				}
				if (name === '/game') {
					initializationStage = 'game.snapshot';
					socket.join(room.game(socketActor)); socket.join(room.installation(socketActor));
					const s = await GameSession.findOne({ ...store, gameId: socketActor.gameId, machineId: socketActor.machineId, installationId: socketActor.installationId, recoverable: true }).lean();
					logger.info({ stage: initializationStage, recovered: Boolean(s), sessionId: s?.sessionId }, 'Socket recovery lookup completed');
					if (s) {
						socket.emit('game.session.snapshot.v1', clean(s));
						socket.emit('reconnect', clean(s));
						const awards = await Award.find({ ...store, gameId: socketActor.gameId, sessionId: s.sessionId, status: { $in: ['RESERVED', 'ACKNOWLEDGED'] } }).lean().exec();
						logger.info({ stage: 'game.awards', count: awards.length }, 'Pending awards recovered');
						for (const award of awards) {
							socket.emit(award.type === 'NORMAL' ? 'game.normal-win.assigned.v1' : 'game.jackpot.awarded.v1', clean(award));
						
						}
					}
				}
				if (name === '/agent') {
					initializationStage = 'agent.snapshot';
					const m = await Machine.findOne({ ...store, machineId: socketActor.machineId }).lean();
					if (m) {

						socket.emit('time.snapshot.v1', clean({ ...m, remainingSeconds: remaining(m) }));
					
					}
					const commands = await Command.find({ ...store, machineId: socketActor.machineId,
						status: { $in: ['REQUESTED', 'ACKNOWLEDGED'] }, expiresAt: { $gt: new Date() } }).lean().exec();
					for (const command of commands) {
						socket.emit(`command.${command.type}.requested.v1`, clean(command));
						
					}
				}
				initializationStage = 'presence';
				await presence(true);
				logger.info({ stage: 'initialization.complete' }, 'Socket initialization completed');
			}
			initialize().catch(error => {
				logger.error({
					stage: initializationStage,
					...failureDetails(error) 
				
				}, 'Socket initialization failed'); 
				socket.disconnect(true);
			});
			for (const eventName of [...canonical, ...Object.keys(legacyEvents)]) {

				socket.on(eventName, async (input, ack) => {
					logger
					const startedAt = Date.now();
					let stage = 'event.authorization';
					let eventId;
					logger.info({
						stage: 'event.received',
						eventName
					}, 'Socket event received');
					let result;
					try {
						await authorized();
						stage = 'event.validation';
						const mapped = legacyEvents[eventName]?.[0] || eventName;
						const event = envelope(input, mapped, socketActor);
						eventId = event.eventId;
                        if (eventName === 'update_game' || eventName === 'game.state.restore.legacy.v1') {
                            const original = event.payload;
                            if (original.deposit !== undefined || original.bank !== undefined) {
                                event.eventName = eventName === 'update_game' ? 'game.state.snapshot.legacy.v1' : eventName;
                                event.payload = normalizeLegacyGameUpdate(original);
                                if (eventName === 'game.state.restore.legacy.v1') {
                                    event.payload.clientRemainingSeconds = Math.max(0, original.remainingTime || 0);
                                    event.payload.clientJackpotState = {
                                        ...original.clientJackpotState,
                                        isJackpot: original.isJackpot || false,
                                        status: original.isJackpotStatus || 'Pending',
                                        freeSpinWinAmount: original.freespinwinamount || 0,
                                        freeSpinReceivedAmounts: original.freespinRecievedAmount || []
                                    };
                                }
                            }
                        }
						if (eventName === 'game_started' && event.payload.username !== undefined) {
							event.eventName = 'game.session.start.legacy.v1';
						}
						stage = 'event.dispatch';
						// logger.info({ stage, eventName, eventId, mappedEvent: event.eventName }, 'Dispatching socket event');
						result = await backend.dispatch(socketActor, event);
						/* logger.info({
							stage: 'event.committed',
							eventName,
							eventId,
							stateVersion: result.stateVersion,
							durationMs: Date.now() - startedAt
						
						}, 'Socket event committed'); */
						const responseName = legacyEvents[eventName]?.[1];
						if (responseName) {

							socket.emit(responseName, result.data);
						}
					} catch (error) {
						const level = !error.code && !validationErrors.includes(error.name) && !(error instanceof SyntaxError) ? 'error' : 'warn';
						logger[level]({ stage, eventName, eventId, durationMs: Date.now() - startedAt, ...failureDetails(error) }, 'Socket event failed');
						result = { 
							ok: false, eventId: input?.eventId || null,
							serverTime: new Date().toISOString(),
							data: null,
							error: errorBody(error) 
						};
						if (['STALE_VERSION', 'SEQUENCE_GAP'].includes(error.code)) {
							
							socket.emit('game.state.resync-required.v1', result.error);
						}
						if (error instanceof SyntaxError) {
							result.error = { code: 'INVALID_PAYLOAD', message: 'Invalid JSON payload' };
						
						}
					}
					if (typeof ack === 'function'){

						ack(result); 
						
					}
					else {
						socket.emit('event.ack.v1', result);
					}
					logger.debug({
						stage: 'event.acknowledged',
						eventName,
						eventId,
						ok: result.ok,
						acknowledgement: typeof ack === 'function' ? 'callback' : 'event' },
						'Socket acknowledgement sent'
					);
				});
			}
			for (const eventName of ['device.hello.v1', 'device.heartbeat.v1', 'agent.version.report.v1']) {
				socket.on(eventName, async (input, ack) => {
					try {
						await authorized();

						z.object({ version: z.string().max(64).optional() }).strict().parse(input || {});

						await presence(true); ack?.({ ok: true, serverTime: new Date().toISOString() });
						// logger.debug({ stage: 'heartbeat.complete', eventName }, 'Device presence refreshed');
					} catch (error) {
						logger.warn({ stage: 'heartbeat.failed', eventName, ...failureDetails(error) }, 'Device heartbeat failed');
						ack?.({
							ok: false,
							error: errorBody(error)
						});
					}
				});
			}
			socket.on('sync.replay.v1', async (input, ack) => {
				try {
					logger.info({ stage: 'replay.start' }, 'Socket replay started');
					await authorized();
					const events = z.array(z.object({
						eventName: z.enum(canonical),
						envelope: z.unknown()
					})).max(100).parse(input);
					
					const results = [];
					
					for (const item of events) {
						try {
							results.push(await backend.dispatch(socketActor, envelope(item.envelope, item.eventName, socketActor))); 
						}
						catch (error) {
							logger.warn({ stage: 'replay.dispatch', eventName: item.eventName, ...failureDetails(error) }, 'Socket replay event failed');
							results.push({ 
								ok: false,
								error: errorBody(error)
							}); 
							break;
						}
					}
					ack?.({ ok: results.every(r => r.ok), results });
					logger.info({ stage: 'replay.complete', processed: results.length, requested: events.length, ok: results.every(r => r.ok) }, 'Socket replay completed');
				} catch (error) {
					logger.warn({
						stage: 'replay.failed',
						...failureDetails(error)
					}, 'Socket replay failed');
					ack?.({ ok: false, error: errorBody(error) });
				}
			});
			socket.on('disconnect', reason => {
				logger.info({ stage: 'connection.disconnected', reason }, 'Socket disconnected');
				closing = true;
				presence(false).catch(error => logger.error({ stage: 'presence.disconnected', ...failureDetails(error) }, 'Presence write failed'));
			});
		});
	}
}
