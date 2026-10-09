import { randomUUID, createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import argon2 from 'argon2';
import { assert, AppError } from '../common/errors.js';
import { id, money, version, reason, settingsSchema, defaultSettings, safeAdd, bps } from '../common/validation.js';
import { requireRole, owners, operators, readers } from '../common/auth.js';
import { createConsoleLogger } from '../common/logging.js';
import { selectUnityJackpot } from './unity-jackkpot.js';
import Inbox from '../models/inbox.js';
import Award from '../models/award.js';
import Pool from '../models/pool.js';
import GameSession from '../models/session.js';
import Ledger from '../models/ledger.js';
import Store from '../models/store.js';
import Period from '../models/period.js';
import Audit from '../models/audit.js';
import Game from '../models/game.js';
import Settings from '../models/settings.js';
import Machine from '../models/machine.js';
import Device from '../models/device.js';
import User from '../models/user.js';
import Card from '../models/card.js';
import Command from '../models/command.js';
import Presence from '../models/presence.js';
import Outbox from '../models/outbox.js';
import HqOutbox from '../models/hq-outbox.js';
import JackpotClient from '../models/jackpot-client.js';
import { createDualJackpot } from './shared-jackpot.js';

const logger = createConsoleLogger();

export const geneRandomId = () => randomUUID();

const defaultMachineTimeSeconds = 7 * 24 * 60 * 60;// 7day expiery timef
export const clean = value => JSON.parse(JSON.stringify(value, (key, v) => ['_id', 'passwordHash', 'secretHash', 'cardUid'].includes(key) ? undefined : v));
export const room = {
	admins: a => `store:${a.storeId}:admins`,
	game: a => `store:${a.storeId}:game:${a.gameId}`,
	machine: a => `store:${a.storeId}:machine:${a.machineId}`,
	
	installation: a => `store:${a.storeId}:installation:${a.installationId}`

};
const manual = ['PLAYER_EXIT_BUTTON', 'PLAYER_X_KEY'];
const exits = [...manual, 'ADMIN_TIME_DELETE', 'TIME_EXPIRED', 'ADMIN_FORCE_EXIT', 'PROCESS_CRASH', 'MACHINE_SHUTDOWN', 'NETWORK_LOST'];

export const remaining = (machine) => machine?.timeStatus === 'ACTIVE' ? Math.max(0, Math.ceil((new Date(machine.deadline) - Date.now()) / 1000)) : machine?.remainingSeconds || 0;


const defaultsCardDataAddded = () => ({
	credit: 200000,
	bank: 0,
	deposit: 0,
	totalBet: 0,
	totalWin: 0,
	bet: 100,
	freeSpins: 0

});
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

export function createBackend(database, config) {
	const dualJackpot = createDualJackpot({ findSession, notify, room, remaining, ledger });
	
	async function dispatch(actor, event) {

		const fingerprint = createHash('sha256').update(stable({
			eventName: event.eventName,
			payload: event.payload,
			sequence: event.sequence ?? null,
			credentialScope: {
				role: actor.role,
				gameId: actor.gameId,
				machineId: actor.machineId, 
				installationId: actor.installationId
			}
		})).digest('hex');
		const key = { storeId: actor.storeId, sourceId: actor.sourceId, eventId: event.eventId };
		const prior = await Inbox.findOne(key).lean();
		if (prior) {
			assert(prior.fingerprint === fingerprint, 'DUPLICATE_EVENT', 'Event ID reused with different content');
			return prior.result;
		}
		try {
			return await database.transaction(async session => {
				const opts = { session };
				
				const store = await Store.findOneAndUpdate({ storeId: actor.storeId, status: 'ACTIVE' }, { $inc: { serverSequence: 1 } }, { ...opts, returnDocument: 'after' }).lean();
				assert(store, 'FORBIDDEN', 'Store is inactive', 403);
				const duplicate = await Inbox.findOne(key, null, opts).lean();
				if (duplicate) { 
					assert(duplicate.fingerprint === fingerprint, 'DUPLICATE_EVENT', 'Event ID reused with different content'); 
					return duplicate.result; 
				
				}
				let period = await Period.findOne({ storeId: actor.storeId, status: 'OPEN' }, null, opts).lean();
				if (!period) { period = { dataId: geneRandomId(), periodId: geneRandomId(), storeId: actor.storeId, status: 'OPEN', openedAt: new Date() }; await Period.insertOne(period, opts); }
				const currentContext = { 
					actor, event, opts, period, store, now: new Date()
				};
				const data = await handle(currentContext);
				const result = { 
					ok: true, eventId: event.eventId, serverSequence: store.serverSequence,
					serverTime: currentContext.now.toISOString(),
					stateVersion: data?.stateVersion ?? null,
					data: clean(data),
					error: null 
				};
				await Inbox.insertOne({
					...key,
					dataId: geneRandomId(),
					fingerprint,
					result,
					
				}, opts);
				await Audit.insertOne({
					dataId: geneRandomId(),
					storeId: actor.storeId,
					gameId: actor.gameId || event.payload.gameId,
					machineId: actor.machineId || event.payload.machineId, actorId: actor.actorId, action: event.eventName,
					eventId: event.eventId, correlationId: event.correlationId, reason: event.payload.reason,
					targetId: data?.sessionId || data?.commandId || data?.cardId || event.payload.gameId || event.payload.machineId,
					stateVersion: data?.stateVersion,
					
				
				}, opts);
				await notify(currentContext, room.admins(actor), 'store.updated.v1', { eventName: event.eventName, serverSequence: store.serverSequence });
				return result;
			});
		} catch (error) {
			if (error.code === 11000) {
				const existing = await Inbox.findOne(key).lean();
				if (existing) { assert(existing.fingerprint === fingerprint, 'DUPLICATE_EVENT', 'Event ID reused with different content'); return existing.result; }
				throw new AppError('CONFLICT', 'A conflicting record already exists', 409);
			}
			throw error;
		}
	}
	async function notify(ctx, targetRoom, eventName, payload) {
		await Outbox.insertOne({
			dataId: geneRandomId(),
			storeId: ctx.actor.storeId,
			room: targetRoom,
			eventName,
			payload: clean(payload),
			status: 'PENDING',
			attempts: 0,
			// createdAt: ctx.now
		}, ctx.opts);
	}
	async function ledger(contexts, type, amount, details = {}) {
		await Ledger.insertOne({
			dataId: geneRandomId(),
			storeId: contexts.actor.storeId,
			gameId: contexts.actor.gameId,
			machineId: contexts.actor.machineId, periodId: contexts.period.periodId, eventId: contexts.event.eventId,
			actorId: contexts.actor.actorId, type, amount, 
			...details, 
			
		}, contexts.opts);
		const total = (contexts.period.totals?.[type] || 0) + amount;


		assert(Number.isSafeInteger(total), 'INVALID_PAYLOAD', 'Period total exceeds safe integer range');

		contexts.period.totals ||= {};
		contexts.period.totals[type] = total;

		await Period.updateOne({ storeId: contexts.actor.storeId, periodId: contexts.period.periodId }, { $set: { [`totals.${type}`]: total } }, contexts.opts);
	}
	async function getSettings(ctx, gameId) {

		const scope = { storeId: ctx.actor.storeId, gameId };
		assert(await Game.findOne({ ...scope, status: 'ACTIVE' }, null, ctx.opts).lean(), 'NOT_FOUND', 'Game not registered', 404);

		let setting = await Settings.findOne(scope, null, { ...ctx.opts, sort: { version: -1 } }).lean();
		if (!setting) { 
			setting = { ...scope, dataId: geneRandomId(), version: 1, settings: defaultSettings }; 
			await Settings.insertOne(setting, ctx.opts); 
		}
		return setting;
	}
	async function findSession(ctx, sessionId, expectedVersion) {
		const { actor, opts, event } = ctx;
		const s = await GameSession.findOne({ storeId: actor.storeId, gameId: actor.gameId,
		machineId: actor.machineId, installationId: actor.installationId, sessionId: id.parse(sessionId) }, null, opts).lean();
		assert(s && s.recoverable, 'SESSION_NOT_ACTIVE', 'Session not recoverable');

		if (expectedVersion !== undefined) {
			assert(s.stateVersion === expectedVersion, 'STALE_VERSION', 'Load the authoritative snapshot', 409);
		
		}
		if (event.sequence !== undefined){
			assert(event.sequence === s.clientSequence + 1, 'SEQUENCE_GAP', 'Replay in order or request snapshot', 409);
		
		}
		return s;
	}
	async function saveSession(ctx, s) {
		s.stateVersion++;
		if (ctx.event.sequence !== undefined) s.clientSequence = ctx.event.sequence;
		s.updatedAt = ctx.now;
		await GameSession.replaceOne({ storeId: s.storeId, gameId: s.gameId, sessionId: s.sessionId }, s, ctx.opts);
		await notify(ctx, room.installation(s), 'game.session.snapshot.v1', s);
		return s;
	}
	async function pool(ctx, gameId, poolType, delta) {
		const scope = { storeId: ctx.actor.storeId, gameId, poolType };
		const current = await Pool.findOne(scope, null, ctx.opts).lean();
		const balance = safeAdd(current?.balance || 0, delta);
		await Pool.updateOne(scope, { $set: { balance, updatedAt: ctx.now }, $setOnInsert: { dataId: geneRandomId() }, $inc: { stateVersion: 1 } }, { ...ctx.opts, upsert: true });
		return balance;
	}
	async function handle(ctx) {
		const { actor: a, event: e, opts, now } = ctx;
		const p = e.payload;
		const storeScope = { storeId: a.storeId };
		const gameId = a.gameId || p.gameId;
		if (['game.jackpot.fund.v1', 'game.jackpot.eligibility.v1', 'game.jackpot.local.check.v1',
            'game.jackpot.offer.respond.v1', 'game.jackpot.shared.tick.internal'].includes(e.eventName))
            return dualJackpot.handle(ctx);
		switch (e.eventName) {
			case 'registry.game.create.v1': {
				requireRole(a, owners);
				const input = z.object({ gameId: id, name: z.string().trim().min(1).max(128), reason }).strict().parse(p);
				const game = { ...storeScope, ...input, dataId: geneRandomId(), status: 'ACTIVE'};
				await Game.insertOne(game, opts);
				await getSettings(ctx, game.gameId);
				return game;
			}
			case 'registry.machine.create.v1': {
				requireRole(a, owners);
				const input = z.object({ machineId: id, machineNumber: z.number().int().positive(), feePlan: money.default(0), reason }).strict().parse(p);
				const machine = { ...storeScope, ...input, dataId: geneRandomId(), timeStatus: 'ACTIVE', remainingSeconds: defaultMachineTimeSeconds,
					deadline: new Date(now.getTime() + defaultMachineTimeSeconds * 1000), stateVersion: 1, };
				await Machine.insertOne(machine, opts);
				return machine;
			}
			case 'registry.device.create.v1': {
				requireRole(a, owners);
				const input = z.object({ deviceId: id, role: z.enum(['GAME_CLIENT', 'DEVICE_TAS_C', 'DEVICE_TAS_K']),
				machineId: id.optional(), gameId: id.optional(), installationId: id.optional(), kioskId: id.optional(),
				secret: z.string().min(24).max(256), reason }).strict().parse(p);
				if (input.role !== 'DEVICE_TAS_K') assert(input.machineId &&
					await Machine.findOne({ ...storeScope, machineId: input.machineId }, null, opts).lean(), 'INVALID_PAYLOAD', 'Registered machine required');
				if (input.role === 'GAME_CLIENT') {
					assert(input.installationId && input.gameId, 'INVALID_PAYLOAD', 'Game and installation identity required');
					await getSettings(ctx, input.gameId);
					assert(!await Device.findOne({ ...storeScope, role: 'GAME_CLIENT', installationId: input.installationId }, null, opts).lean(), 'CONFLICT', 'Installation already enrolled', 409);
				}
				if (input.role === 'DEVICE_TAS_K') {
					assert(input.kioskId && !input.machineId && !input.gameId && !input.installationId, 'INVALID_PAYLOAD', 'Kiosk identity required; game scope is not allowed');
				
				}
				if (input.role === 'DEVICE_TAS_C') {
					assert(!input.gameId && !input.installationId && !input.kioskId, 'INVALID_PAYLOAD', 'Agent credentials must be machine scoped');
					
				}
				const { secret, ...fields } = input;
				const device = { ...storeScope, ...fields, dataId: geneRandomId(),
					secretHash: await argon2.hash(secret, { type: argon2.argon2id }), status: 'ACTIVE'};
				await Device.insertOne(device, opts);
				return device;
			}
			case 'registry.device.revoke.v1': {
				requireRole(a, owners);
				const input = z.object({ deviceId: id, reason }).strict().parse(p);
				const result = await Device.updateOne({
					...storeScope,
					deviceId: input.deviceId
					
				}, { $set: { status: 'REVOKED', revokedAt: now } }, opts);
				assert(result.matchedCount, 'NOT_FOUND', 'Device not found', 404);
				return {

					deviceId: input.deviceId,
					status: 'REVOKED'
				
				};
			}
			case 'registry.user.create.v1': {
				requireRole(a, owners);
				const input = z.object({ username: id, role: z.enum(['STORE_OWNER', 'STORE_STAFF', 'READ_ONLY_AUDITOR']), password: z.string().min(12).max(256), reason }).strict().parse(p);
				const { password, ...fields } = input;
				logger.info(input,"inputs ");
				const user = {
					...storeScope,
					...fields,
					dataId: geneRandomId(),
					userId: geneRandomId(),
					tokenVersion: 1,
					passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
					status: 'ACTIVE',
				
				};
				await User.insertOne(user, opts);
				return user;
			}
			case 'game.session.start.legacy.v1':
			case 'game.session.start.v1': {
				requireRole(a, ['GAME_CLIENT']);
				const legacy = e.eventName === 'game.session.start.legacy.v1';
				const input = legacy ? z.object({ 
					username: z.string().trim().min(1).max(128),
					systemId: z.number().int().positive(),
					remainingTime: z.number().int().nonnegative(),
					cardId: id.optional() 
				}).strict().parse(p) : z.object({ cardId: id }).strict().parse(p);

				const setting = await getSettings(ctx, a.gameId);
				const machine = await Machine.findOne({ ...storeScope, machineId: a.machineId }, null, opts).lean();

				/* logger?.info({
					stage: 'session.start.machine',
					eventId: e.eventId,
					storeId: a.storeId,
					machineId: a.machineId,
					found: Boolean(machine),
					timeStatus: machine?.timeStatus,
					remainingSeconds: remaining(machine),
					hasCard: Boolean(machine?.cardId),
					legacy
				}, 'Game start machine eligibility checked'); */
				assert(machine && machine.timeStatus === 'ACTIVE' &&
					remaining(machine) > 0, 'TIME_REQUIRED', 'Active PC usage time is required');
				if (legacy) {

					assert(input.systemId === machine.machineNumber, 'FORBIDDEN', 'Selected system must match the authenticated device machine', 403);
					assert(machine.cardId, 'CARD_REQUIRED', 'Assign a card to the PC time session before starting Unity');
					assert(input.cardId === undefined || input.cardId === machine.cardId, 'FORBIDDEN', 'Card must match PC time session', 403);
					input.cardId = machine.cardId;
				}
				assert(machine.cardId === input.cardId, 'FORBIDDEN', 'Card must match PC time session', 403);
				assert(await Card.findOne({ ...storeScope, cardId: input.cardId, status: 'ACTIVE' }, null, opts).lean(), 'CARD_INACTIVE', 'Card inactive');
				let s = await GameSession.findOne({ ...storeScope, gameId: a.gameId, installationId: a.installationId, recoverable: true }, null, opts).lean();
				if (s) {
					assert(s.cardId === input.cardId, 'RECOVERY_CARD_MISMATCH', 'Recoverable balance belongs to another card', 409);
					if (e.sequence !== undefined){
						assert(e.sequence === s.clientSequence + 1, 'SEQUENCE_GAP', 'Resume sequence must follow the snapshot', 409);

					}
					s.status = 'ACTIVE';
					await saveSession(ctx, s);
				} else {
					if (e.sequence !== undefined) {
						assert(e.sequence === 1, 'SEQUENCE_GAP', 'New session sequence must begin at 1', 409);
					}
					s = { ...storeScope, gameId: a.gameId, machineId: a.machineId, installationId: a.installationId,
						dataId: geneRandomId(), sessionId: geneRandomId(),
						cardId: input.cardId, status: 'ACTIVE', recoverable: true,
						stateVersion: 1, clientSequence: e.sequence || 0,
						state: defaultsCardDataAddded(), 
						settingsVersion: setting.version
						
					};

					await GameSession.insertOne(s, opts);
					await notify(ctx, room.installation(a), 'game.session.started.v1', s);
				}
                const installationPools = await JackpotClient.findOne({ ...storeScope, gameId: a.gameId,
                    installationId: a.installationId }, null, opts).lean();
                if (installationPools?.localPools && Object.keys(installationPools.localPools).length) {
                    s.gameplayPools = installationPools.localPools;
                    await GameSession.replaceOne({ ...storeScope, sessionId: s.sessionId }, s, opts);
                }
				return { ...s, remainingSeconds: remaining(machine), settings: setting };
			}
			case 'game.session.snapshot.get.v1': {
				requireRole(a, ['GAME_CLIENT']);
				const s = await GameSession.findOne({
					...storeScope, gameId: a.gameId, machineId: a.machineId, installationId: a.installationId, recoverable: true }, null, opts).lean();
				const awards = s ? await Award.find({
					...storeScope, gameId: a.gameId, sessionId: s.sessionId, status: { $in: ['RESERVED', 'ACKNOWLEDGED'] } }, null, opts).lean().exec() : [];
				return {
					session: s,
					pendingAwards: awards,
					expectedNextSequence: (s?.clientSequence || 0) + 1 
				};
			}
            case 'game.state.snapshot.legacy.v1':
            case 'game.state.restore.legacy.v1': {
                requireRole(a, ['GAME_CLIENT']);
                const restoring = e.eventName === 'game.state.restore.legacy.v1';
                const input = z.object({ sessionId: id, stateVersion: version, credit: money, bank: money,
                    jackpotAwardId: id.optional(), jackpotCompleted: z.boolean().optional(),
                    clientRemainingSeconds: money.optional(),
                    clientBet: money.optional(),
                    clientJackpotState: z.object({
						isJackpot: z.boolean(), status: z.string().max(32),
                        jackpotType: z.string().max(32).optional(),
						jackpotAmount: money.optional(),
                        minimumJackpotAmount: money.optional(), roundsRemaining: money.optional(),
                        roundAmounts: z.array(money).max(1024).optional(), receiveJackpot: z.boolean().optional(),
                        freeSpinWinAmount: money, freeSpinReceivedAmounts: z.array(money).max(1024) }).strict().optional(),
                    	gameplayPools: z.object({ smallJackpot: money, mediumJackpot: money, bigJackpot: money,
                        normalWinning: money, rtp: money, commission: money }).strict().optional()
                }).strict().parse(p);
                
                const s = await findSession(ctx, input.sessionId, input.stateVersion);
                const machine = await Machine.findOne({ ...storeScope, machineId: a.machineId }, null, opts).lean();
                assert(s.status === 'ACTIVE' && (restoring || (machine?.timeStatus === 'ACTIVE' && remaining(machine) > 0)),
                    'SESSION_NOT_ACTIVE', 'Game or PC time is inactive');
                if (!restoring) {
					assert(input.credit <= s.state.credit, 'INVALID_PAYLOAD', 'Additional credit requires game.credit.deposit.v1');
				
				}
                const spent = Math.max(0, s.state.credit - input.credit);
                const won = Math.max(0, input.bank - s.state.bank);
                s.state.totalBet = safeAdd(s.state.totalBet, spent);
                s.state.totalWin = safeAdd(s.state.totalWin, won);
				
                if (spent) {

                    if (!restoring) s.state.bet = spent;
                    await ledger(ctx, 'bet', spent, { sessionId: s.sessionId, cardId: s.cardId, gameplayMode: 'UNITY_LOCAL' });
                }
                if (won) await ledger(ctx, 'legacy_game_win', won, { sessionId: s.sessionId, cardId: s.cardId });
                await ledger(ctx, 'legacy_game_snapshot', 0, { sessionId: s.sessionId,
                    previousCredit: s.state.credit, previousBank: s.state.bank, credit: input.credit, bank: input.bank });
                if (restoring) {
                    await ledger(ctx, 'client_state_restored', 0, { sessionId: s.sessionId,
                        previousCredit: s.state.credit, previousBank: s.state.bank, credit: input.credit, bank: input.bank });
                    if (input.clientRemainingSeconds !== undefined) s.gameplayRemainingSeconds = input.clientRemainingSeconds;
                    if (input.clientBet !== undefined) s.state.bet = input.clientBet;
                    if (input.clientJackpotState) s.gameplayJackpotState = input.clientJackpotState;
                }
                s.state.credit = input.credit;
                s.state.bank = input.bank;
                if (input.jackpotAwardId) {
                    const award = await Award.findOne({ ...storeScope, gameId: a.gameId,
                        installationId: a.installationId, machineId: a.machineId, sessionId: s.sessionId,
                        awardId: input.jackpotAwardId, gameplayMode: 'UNITY_LOCAL' }, null, opts).lean();
                    assert(award, 'INVALID_AWARD', 'Award does not belong to this Unity session');
                    if (award.status !== 'COMPLETED') {
                        await Award.updateOne({ ...storeScope, awardId: award.awardId }, { $set: {
                            status: input.jackpotCompleted ? 'COMPLETED' : 'ACKNOWLEDGED',
                            updatedAt: now, ...(input.jackpotCompleted ? { completedAt: now } : {})
                        } }, opts);
                    }
                    // The legacy bank snapshot above already includes the payout.
                }
                s.gameplayMode = 'UNITY_LOCAL';
                if (input.gameplayPools) {
                    s.gameplayPools = input.gameplayPools;
                    await JackpotClient.updateOne({ ...storeScope, gameId: s.gameId, installationId: s.installationId },
                        { $set: { localPools: s.gameplayPools } }, { ...opts, upsert: true });
                }
                if (input.jackpotCompleted && s.activeDualAwardId === input.jackpotAwardId){

                    delete s.activeDualAwardId;
				}
                /* logger?.debug({
					stage: 'gameplay.legacy-sync',
					sessionId: s.sessionId,
					spent,
					won,
                    credit: input.credit, bank: input.bank }, 
					
				'Unity gameplay result recorded without generating a server payout'); */
                return saveSession(ctx, s);
            }
			case 'game.state.update.v1': {
				requireRole(a, ['GAME_CLIENT']);
				const input = z.object({
					sessionId: id,
					stateVersion: version,
					betAmount: money.default(0),
					assignmentId: id.optional()
				}).strict().parse(p);
				const s = await findSession(ctx, input.sessionId, input.stateVersion);
				const machine = await Machine.findOne({ ...storeScope, machineId: a.machineId }, null, opts).lean();

				assert(s.status === 'ACTIVE' && machine?.timeStatus === 'ACTIVE' && remaining(machine) > 0, 'SESSION_NOT_ACTIVE', 'Game or PC time is inactive');
				if (input.assignmentId) {
					const award = await Award.findOne({ ...storeScope,
						gameId: a.gameId,
						sessionId: s.sessionId,
						awardId: input.assignmentId,
						type: 'NORMAL',
						status: 'RESERVED'
					}, null, opts).lean();
					assert(award, 'INVALID_AWARD', 'Normal win assignment is invalid');

					s.state.bank = safeAdd(s.state.bank, award.amount); s.state.totalWin = safeAdd(s.state.totalWin, award.amount);

					await Award.updateOne({ ...storeScope, awardId: award.awardId }, 
						{ $set: { status: 'COMPLETED', completedAt: now } }, opts);
					await ledger(ctx, 'normal_win', award.amount, { sessionId: s.sessionId, cardId: s.cardId, awardId: award.awardId });
				}
				assert(s.state.credit >= input.betAmount, 'INSUFFICIENT_BALANCE', 'Not enough credit');


				let assignment = null;
				if (input.betAmount) {
					const betAward = !await Award.findOne({
						...storeScope,
						gameId: a.gameId,
						sessionId: s.sessionId,
						type: 'NORMAL',
						status: 'RESERVED'
					}, null, opts).lean();

					assert(betAward, 'AWARD_PENDING', 'Complete the previous normal win assignment');
					s.state.credit -= input.betAmount; s.state.bet = input.betAmount; s.state.totalBet = safeAdd(s.state.totalBet, input.betAmount);


					const setting = await Settings.findOne({
						...storeScope,
						gameId: a.gameId,
						version: s.settingsVersion
					
					}, null, opts).lean();
					const normalPart = bps(input.betAmount, setting.settings.normalWinning.percentageBps);
					const jackpotPart = input.betAmount - normalPart;
					const sj = bps(jackpotPart, setting.settings.smallJackpot.percentageBps);
					const mj = bps(jackpotPart, setting.settings.mediumJackpot.percentageBps);

					await pool(ctx, a.gameId, 'SJ', sj); 
					await pool(ctx, a.gameId, 'MJ', mj);
					await pool(ctx, a.gameId, 'BJ', jackpotPart - sj - mj);

					const balance = await pool(ctx, a.gameId, 'NORMAL', normalPart);
					
					const cap = Math.min(balance, input.betAmount * 2, 1_000_000_000);
					const amount = randomInt(cap + 1);
					if (amount) {
						await pool(ctx, a.gameId, 'NORMAL', -amount);
						assignment = { ...storeScope, dataId: geneRandomId(), awardId: geneRandomId(), gameId: a.gameId, machineId: a.machineId,
						installationId: a.installationId, sessionId: s.sessionId, type: 'NORMAL', amount, status: 'RESERVED', /* createdAt: now */ };
						await Award.insertOne(assignment, opts);

						await notify(ctx, room.installation(a), 'game.normal-win.assigned.v1', assignment);
					}
					await ledger(ctx, 'bet', input.betAmount, { sessionId: s.sessionId, cardId: s.cardId });
				}
				await saveSession(ctx, s);
				return { ...s, assignment };
			}
			case 'game.credit.deposit.v1': {
				requireRole(a, ['GAME_CLIENT']);

				const input = z.object({
					sessionId: id,
					stateVersion: version,
					amount: money.refine(v => v > 0)
				
				}).strict().parse(p);

				const s = await findSession(ctx, input.sessionId, input.stateVersion);
				const machine = await Machine.findOne({ ...storeScope, machineId: a.machineId }, null, opts).lean();
				
				assert(s.status === 'ACTIVE' && machine?.timeStatus === 'ACTIVE' && remaining(machine) > 0, 'SESSION_NOT_ACTIVE', 'Active usage time required');

				const card = await Card.findOne({ ...storeScope, cardId: s.cardId, status: 'ACTIVE' }, null, opts).lean();

				assert(card && card.points >= input.amount, 'INSUFFICIENT_BALANCE', 'Not enough card points');

				await Card.updateOne({ ...storeScope, cardId: s.cardId }, { $inc: { points: -input.amount, stateVersion: 1 } }, opts);

				s.state.credit = safeAdd(s.state.credit, input.amount); s.state.deposit = safeAdd(s.state.deposit, input.amount);

				await ledger(ctx, 'game_deposit', input.amount, { sessionId: s.sessionId, cardId: s.cardId, cardDelta: -input.amount });

				return saveSession(ctx, s);
			}
			case 'game.session.exit.v1': {
				requireRole(a, ['GAME_CLIENT']);
				const input = z.object({
					sessionId: id,
					stateVersion: version,
					exitReason: z.enum(exits)
				
				}).strict().parse(p);
				logger.info(input)
				const s = await findSession(ctx, input.sessionId, input.stateVersion);
				const pending = await Award.countDocuments({ ...storeScope, gameId: a.gameId, sessionId: s.sessionId, status: { $in: ['RESERVED', 'ACKNOWLEDGED'] } }, opts);
				if (manual.includes(input.exitReason)) {

					assert(pending === 0, 'AWARD_PENDING', 'Complete reserved awards before player exit');

					const setting = await Settings.findOne({ ...storeScope, gameId: a.gameId, version: s.settingsVersion }, null, opts).lean();

					const commission = setting.settings.commission.enabled ? bps(s.state.bank, setting.settings.commission.percentageBps) : 0;
					const amount = safeAdd(s.state.credit, s.state.bank - commission);
					const card = await Card.findOne({ ...storeScope, cardId: s.cardId }, null, opts).lean();
					assert(card, 'NOT_FOUND', 'Card missing', 404);
					const points = safeAdd(card.points, amount);

					await Card.updateOne({ ...storeScope, cardId: s.cardId }, { $set: { points }, $inc: { stateVersion: 1 } }, opts);
					await ledger(ctx, 'player_exit', amount, {

						sessionId: s.sessionId,
						cardId: s.cardId, cardDelta: amount, credit: s.state.credit, bank: s.state.bank, commission });
					s.state.credit = 0; s.state.bank = 0; s.status = 'CLOSED'; s.recoverable = false; s.closedAt = now;
				} else {
					s.status = 'INTERRUPTED'; 
				}
				s.exitReason = input.exitReason;
				return saveSession(ctx, s);
			}
			case 'game.settings.get.v1':
			case 'game.settings.lock-status.v1':
			case 'game.pool.summary.get.v1': {
				requireRole(a, ['GAME_CLIENT', ...operators, 'READ_ONLY_AUDITOR']);
				id.parse(gameId);
				if (e.eventName === 'game.settings.get.v1') return getSettings(ctx, gameId);
				if (e.eventName === 'game.pool.summary.get.v1') {
					requireRole(a, ['GAME_CLIENT', ...readers]);
					return {
						pools: await Pool.find({ ...storeScope, gameId }, null, opts).lean().exec()
						
					};
				}
				const activeCount = await GameSession.countDocuments({ ...storeScope, gameId, status: 'ACTIVE' }, opts);
				return {
					gameId,
					activeCount,
					editable: activeCount === 0
				};
			}
			case 'game.settings.update.v1': {
				requireRole(a, owners);
				const input = z.object({
					gameId: id,
					expectedVersion: version,
					settings: settingsSchema,
					reason
				}).strict().parse(p);
				const old = await getSettings(ctx, input.gameId);
				assert(old.version === input.expectedVersion, 'STALE_VERSION', 'Settings version changed', 409);
				assert(!await GameSession.findOne({
					...storeScope,
					gameId: input.gameId,
					status: 'ACTIVE'
				}, null, opts).lean(), 'SETTINGS_LOCKED', 'Active sessions prevent settings changes', 409);
				const next = { ...storeScope, dataId: geneRandomId(), gameId: input.gameId, version: old.version + 1, settings: input.settings, reason: input.reason, actorId: a.actorId };
				await Settings.insertOne(next, opts);
				await notify(ctx, room.game(next), 'game.settings.updated.v1', next);
				
				return next;
			}
			case 'card.create.v1': {
				requireRole(a, operators);
				const input = z.object({ cardId: id, cardUid: id, displayNumber: z.string().max(32) }).strict().parse(p);
				const card = { ...storeScope, ...input, dataId: geneRandomId(), status: 'ACTIVE', points: 0, stateVersion: 1 };
				await Card.insertOne(card, opts);
				return card;
			}
			case 'card.validate.v1': {
				requireRole(a, ['DEVICE_TAS_C', 'DEVICE_TAS_K', ...operators]);
				const input = z.object({ cardId: id }).strict().parse(p);
				const card = await Card.findOne({ ...storeScope, cardId: input.cardId, status: 'ACTIVE' }, null, opts).lean();
				assert(card, 'CARD_INACTIVE', 'Card not valid');
				
				return card;
			}
			case 'card.adjust.v1':
			case 'kiosk.topup.requested.v1': {
				if (e.eventName === 'card.adjust.v1') requireRole(a, owners); else requireRole(a, ['DEVICE_TAS_K']);
				const input = z.object({ cardId: id, amount: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000).refine(v => v !== 0), reason, billId: id.optional() }).strict().parse(p);
				if (a.role === 'DEVICE_TAS_K') {
					
					assert(input.amount > 0 && input.billId, 'INVALID_PAYLOAD', 'Positive amount and billId required');
					const earlier = await Ledger.findOne({ ...storeScope, kioskId: a.kioskId, billId: input.billId }, null, opts).lean();
					if (earlier) {
						assert(earlier.amount === input.amount && earlier.cardId === input.cardId, 'DUPLICATE_EVENT', 'Bill already assigned'); 
						return { cardId: earlier.cardId, billId: earlier.billId, completed: true }; 

					}
				}
				const card = await Card.findOne({ ...storeScope, cardId: input.cardId, status: 'ACTIVE' }, null, opts).lean();
				assert(card, 'CARD_INACTIVE', 'Card inactive');
				const points = safeAdd(card.points, input.amount);
				await Card.updateOne({ ...storeScope, cardId: input.cardId }, { $set: { points }, $inc: { stateVersion: 1 } }, opts);
				await ledger(ctx, a.role === 'DEVICE_TAS_K' ? 'topup' : 'card_adjustment', input.amount, { cardId: card.cardId,
				cardDelta: input.amount, balanceAfter: points, kioskId: a.kioskId, billId: input.billId, reason: input.reason });

				return { ...card, points, stateVersion: card.stateVersion + 1, completed: true };
			}
			case 'time.session.start.v1':
			case 'time.add.paid.v1':
			case 'time.add.service.v1':
			case 'time.add.maintenance.v1':
			case 'time.pause.v1':
			case 'time.resume.v1':
			case 'time.delete.v1':
			case 'time.expire.internal': {
				requireRole(a, e.eventName === 'time.expire.internal' ? ['SYSTEM'] : operators);
				const input = z.object({ machineId: id, cardId: id.optional(), minutes: z.number().int().positive().optional(),
				expectedVersion: version, reason, amount: money.optional() }).strict().parse(p);
				const m = await Machine.findOne({ ...storeScope, machineId: input.machineId }, null, opts).lean();
				assert(m, 'NOT_FOUND', 'Machine missing', 404);
				assert(m.stateVersion === input.expectedVersion, 'STALE_VERSION', 'Machine version changed', 409);
				let seconds = remaining(m), delta = 0;

				if (e.eventName.includes('add.') || e.eventName === 'time.session.start.v1') {
					assert(input.minutes && input.minutes <= (e.eventName.includes('maintenance') ? 10 : 500), 'INVALID_PAYLOAD', 'Time addition exceeds per-operation limit');
					if (input.cardId) {
						assert(await Card.findOne({ ...storeScope, cardId: input.cardId, status: 'ACTIVE' }, null, opts).lean(), 'CARD_INACTIVE', 'Card inactive');
						assert(!await GameSession.findOne({ ...storeScope, machineId: m.machineId, recoverable: true, cardId: { $ne: input.cardId } }, null, opts).lean(), 'RECOVERY_CARD_MISMATCH', 'Previous card has recoverable game balance');
						assert(seconds === 0 || !m.cardId || m.cardId === input.cardId, 'FORBIDDEN', 'Cannot replace the current card', 403);
						m.cardId = input.cardId;
					}
					assert(m.cardId, 'INVALID_PAYLOAD', 'A card is required');
					delta = input.minutes * 60;
					seconds = safeAdd(seconds, delta);
					if (m.timeStatus !== 'PAUSED') {
						m.timeStatus = 'ACTIVE';
					
					}
					if (e.eventName === 'time.add.paid.v1' || e.eventName === 'time.session.start.v1') {
						assert(input.amount !== undefined, 'INVALID_PAYLOAD', 'Paid time requires an explicit amount');
						const card = await Card.findOne({ ...storeScope, cardId: m.cardId, status: 'ACTIVE' }, null, opts).lean();
						assert(card && card.points >= input.amount, 'INSUFFICIENT_BALANCE', 'Not enough card points');
						await Card.updateOne({ ...storeScope, cardId: m.cardId }, { $inc: { points: -input.amount, stateVersion: 1 } }, opts);
						await ledger(ctx, 'paid_time', input.amount, { machineId: m.machineId, cardId: m.cardId, cardDelta: -input.amount, seconds: delta });
					}
				} else if (e.eventName === 'time.pause.v1') {
				
					assert(m.timeStatus === 'ACTIVE' && seconds > 0, 'INVALID_STATE', 'No active time'); 
					m.timeStatus = 'PAUSED'; 
				}
				else if (e.eventName === 'time.resume.v1') {
				
					assert(m.timeStatus === 'PAUSED' && seconds > 0, 'INVALID_STATE', 'No paused time'); 
					m.timeStatus = 'ACTIVE'; 
				}
				else {
					if (e.eventName === 'time.expire.internal') assert(m.timeStatus === 'ACTIVE' && seconds === 0, 'INVALID_STATE', 'Time not expired');
					delta = -seconds;
					seconds = 0;

					m.timeStatus = 'IDLE';

					const sessions = await GameSession.find({ ...storeScope, machineId: m.machineId, status: 'ACTIVE' }, null, opts).lean().exec();
					for (const s of sessions) {
						
						s.status = 'INTERRUPTED';
						s.exitReason = e.eventName === 'time.delete.v1' ? 'ADMIN_TIME_DELETE' : 'TIME_EXPIRED';
						await saveSession(ctx, s);
						await notify(ctx, room.installation(s), 'game.command.force-exit.v1', { sessionId: s.sessionId, exitReason: s.exitReason });
					}
				}
				m.remainingSeconds = seconds; m.deadline = m.timeStatus === 'ACTIVE' ? new Date(now.getTime() + seconds * 1000) : null; m.stateVersion++;
				await Machine.replaceOne({ ...storeScope, machineId: m.machineId }, m, opts);
				await ledger(ctx, 'time_change', delta, { machineId: m.machineId, cardId: m.cardId, mode: e.eventName, reason: input.reason });
				await notify(ctx, room.machine(m), 'time.snapshot.v1', { ...m, remainingSeconds: remaining(m) });
				return m;
			}
			case 'time.snapshot.get.v1': {
				requireRole(a, ['DEVICE_TAS_C', 'GAME_CLIENT', ...operators]);
				const m = await Machine.findOne({ ...storeScope, machineId: a.machineId || id.parse(p.machineId) }, null, opts).lean();
				assert(m, 'NOT_FOUND', 'Machine missing', 404);
				
				return { ...m, remainingSeconds: remaining(m) };
			}
			case 'command.request.v1': {
				requireRole(a, operators);
				const input = z.object({ machineId: id, type: z.enum(['shutdown', 'reboot', 'agent-stop', 'screen-lock', 'screen-unlock']), reason }).strict().parse(p);
				assert(await Machine.findOne({ ...storeScope, machineId: input.machineId }, null, opts).lean(), 'NOT_FOUND', 'Machine missing', 404);
				const command = {
					...storeScope,
					...input,
					dataId: geneRandomId(),
					commandId: geneRandomId(),
					issuer: a.actorId,
					status: 'REQUESTED',
					// createdAt: now,
					expiresAt: new Date(now.getTime() + 30000)
				
				};
				await Command.insertOne(command, opts);
				
				await notify(ctx, room.machine(command), `command.${input.type}.requested.v1`, command);
				
				return command;
			}
			case 'command.ack.v1':
			case 'command.result.v1': {

				requireRole(a, ['DEVICE_TAS_C']);

				const input = z.object({ commandId: id, success: z.boolean().optional(), message: z.string().max(500).optional() }).strict().parse(p);
				const command = await Command.findOne({ ...storeScope, machineId: a.machineId, commandId: input.commandId }, null, opts).lean();
				assert(command && command.expiresAt > now && ['REQUESTED', 'ACKNOWLEDGED'].includes(command.status), 'COMMAND_TIMEOUT', 'Command expired or completed');

				if (e.eventName === 'command.result.v1') {

					assert(command.status === 'ACKNOWLEDGED' && input.success !== undefined, 'INVALID_STATE', 'Acknowledge command before result');
				
				}
				command.status = e.eventName === 'command.ack.v1' ? 'ACKNOWLEDGED' : input.success ? 'SUCCEEDED' : 'FAILED';
				command.updatedAt = now;
				command.message = input.message;
				await Command.replaceOne({ ...storeScope, commandId: command.commandId }, command, opts);
				
				return command;
			}
			case 'settlement.close.v1': {
				requireRole(a, owners);
				const input = z.object({ reason }).strict().parse(p);
				const { _id, ...periodDocument } = ctx.period;
				const snapshot = { ...periodDocument, status: 'CLOSED', reason: input.reason, closedAt: now, actorId: a.actorId };
				snapshot.checksum = createHash('sha256').update(stable(snapshot)).digest('hex');
				await Period.replaceOne({ ...storeScope, periodId: ctx.period.periodId }, snapshot, opts);
				await Period.insertOne({ ...storeScope, dataId: geneRandomId(), periodId: geneRandomId(), status: 'OPEN', openedAt: now }, opts);
				await HqOutbox.insertOne({
					...storeScope,
					dataId: geneRandomId(),
					type: 'settlement.closed',
					payload: snapshot,
					status: 'PENDING',
					// createdAt: now,
					attempts: 0
				
				}, opts);
				return snapshot;
			}
            case 'game.jackpot.check.v1': {
                requireRole(a, ['GAME_CLIENT']);

                const amounts = z.array(money.refine(value => value > 0)).min(1).max(1024);
                const ranges = z.array(money).length(6).refine(values =>
                    [0, 2, 4].every(i => values[i] > 0 && values[i] <= values[i + 1]));
                const input = z.object({ sessionId: id, stateVersion: version, theme: z.string().max(32),

                    governmentBuild: z.boolean().optional(),
                    smallJackpot: money, mediumJackpot: money, bigJackpot: money,
                    minimumPools: z.array(money.refine(value => value > 0)).length(3),
                    smallAmounts: amounts, mediumAmounts: amounts, bigAmounts: amounts,
                    smallLevelRanges: ranges, mediumLevelRanges: ranges, bigLevelRanges: ranges
                }).strict().parse(p);
                const s = await findSession(ctx, input.sessionId, input.stateVersion);

                const machinesss = await Machine.findOne({ ...storeScope, machineId: a.machineId }, null, opts).lean();
                assert(s.status === 'ACTIVE' && machinesss?.timeStatus === 'ACTIVE' && remaining(machinesss) > 0,
                    'SESSION_NOT_ACTIVE', 'Game or PC time is inactive');
					
                const pending = await Award.findOne({ ...storeScope, sessionId: s.sessionId,
                    type: { $ne: 'NORMAL' }, status: { $in: ['WAITING_FOR_FUNDS', 'RESERVED', 'ACKNOWLEDGED'] } }, null, opts).lean();
                if (pending?.status === 'WAITING_FOR_FUNDS') {
                    if ((s.gameplayPools?.[pending.poolKey] || 0) < pending.amount)
                        return { sessionId: s.sessionId, stateVersion: s.stateVersion, award: null };
                    s.gameplayPools[pending.poolKey] -= pending.amount;
                    pending.status = 'RESERVED';
                    await Award.updateOne({ ...storeScope, awardId: pending.awardId },
                        { $set: { status: 'RESERVED', updatedAt: now } }, opts);
                    await saveSession(ctx, s);
                    await notify(ctx, room.installation(s), 'game.jackpot.awarded.v1', pending);
                }
                if (pending) {
					return {
						sessionId: s.sessionId,
						stateVersion: s.stateVersion,
						award: pending.gameplayMode === 'UNITY_LOCAL' ? pending : null 
					};
				}
                
                const selected = selectUnityJackpot(s.gameplayPools, input);
				logger.info(selected,"Jp Selected");
                if (!selected) {

					return {
						sessionId: s.sessionId,
						stateVersion: s.stateVersion,
						award: null
					};
				}
                const funded = s.gameplayPools[selected.poolKey] >= selected.amount;
                if (funded) {
				
					s.gameplayPools[selected.poolKey] -= selected.amount;
				}
                const awardId = geneRandomId();
                const award = {
					...selected,
					dataId: geneRandomId(),
					awardId,
					eventId: awardId,
                    storeId: s.storeId,
					gameId: s.gameId,
					machineId: s.machineId,
                    installationId: s.installationId,
					sessionId: s.sessionId,
                    gameplayMode: 'UNITY_LOCAL',
					status: funded ? 'RESERVED' : 'WAITING_FOR_FUNDS'
				};
                await Award.insertOne(award, opts);
                await saveSession(ctx, s);
                if (funded) {
					await notify(ctx, room.installation(s), 'game.jackpot.awarded.v1', award);
				
				}
                return {

					sessionId: s.sessionId,
					stateVersion: s.stateVersion,
					award: funded ? award : null
				
				};
            }
			case 'game.jackpot.reserve.v1':
			case 'game.jackpot.test.v1': {

				requireRole(a, owners);
				if (e.eventName === 'game.jackpot.test.v1') {
					assert(config.testJackpot, 'FORBIDDEN', 'Test jackpots are disabled', 403);
					return { testOnly: true, simulated: true, amount: money.parse(p.amount), gameId: id.parse(p.gameId) };
				}
				const input = z.object({
					gameId: id,
					sessionId: id,
					poolType: z.enum(['SJ', 'MJ', 'BJ']),
					amount: money.refine(v => v > 0),
					
					reason,
				allFruit: z.object({ variant: z.string().min(1).max(32) }).strict().optional() }).strict().parse(p);
				const s = await GameSession.findOne({ ...storeScope, gameId: input.gameId, sessionId: input.sessionId, status: 'ACTIVE' }, null, opts).lean();
				assert(s, 'SESSION_NOT_ACTIVE', 'Target session inactive');
				assert(!await Award.findOne({
					...storeScope,
					sessionId: s.sessionId,
					type: { $ne: 'NORMAL' },
					status: {
						$in: ['WAITING_FOR_FUNDS', 'RESERVED', 'ACKNOWLEDGED'] 
					
					}
				}, null, opts).lean(), 'AWARD_PENDING', 'Jackpot already pending');


				await pool(ctx, input.gameId, input.poolType, -input.amount);
				return reserveAward(ctx, s, input.poolType, input.amount, input.allFruit);
			}
			case 'game.jackpot.progress.v1': {
				requireRole(a, ['GAME_CLIENT']);
				const input = z.object({ sessionId: id, stateVersion: version, awardId: id, status: z.enum(['ACKNOWLEDGED', 'COMPLETED']) }).strict().parse(p);
				const s = await findSession(ctx, input.sessionId, input.stateVersion);
				const award = await Award.findOne({ ...storeScope, gameId: a.gameId, machineId: a.machineId,
				installationId: a.installationId, sessionId: s.sessionId, awardId: input.awardId, type: { $ne: 'NORMAL' } }, null, opts).lean();
				assert(award, 'INVALID_AWARD', 'Award does not belong to this session');
				if (award.status === 'COMPLETED') {
				
					return saveSession(ctx, s);
				}
				if (input.status === 'COMPLETED') {
					s.state.bank = safeAdd(s.state.bank, award.amount); s.state.totalWin = safeAdd(s.state.totalWin, award.amount);
					await ledger(ctx, 'jackpot_win', award.amount, { sessionId: s.sessionId, cardId: s.cardId, awardId: award.awardId, allFruit: award.allFruit });
				}
				await Award.updateOne({ ...storeScope, awardId: award.awardId }, { $set: { status: input.status, updatedAt: now } }, opts);
				return saveSession(ctx, s);
			}
			case 'network.tick.internal': {
				requireRole(a, ['SYSTEM']);
				const sessions = await GameSession.find({ ...storeScope, status: 'ACTIVE' }, null, opts).lean().exec();
				const candidates = [];
				for (const s of sessions) {
					const m = await Machine.findOne({ ...storeScope, machineId: s.machineId }, null, opts).lean();
					const agent = await Presence.findOne({ ...storeScope, machineId: s.machineId, role: 'DEVICE_TAS_C', connected: true, lastSeenAt: { $gt: new Date(now.getTime() - 15000) } }, null, opts).lean();
					const game = await Presence.findOne({ ...storeScope, installationId: s.installationId, role: 'GAME_CLIENT', connected: true, lastSeenAt: { $gt: new Date(now.getTime() - 15000) } }, null, opts).lean();
					const pending = await Award.findOne({ ...storeScope, sessionId: s.sessionId, status: {
						$in: ['RESERVED', 'ACKNOWLEDGED'] },
						type: { $ne: 'NORMAL' } 
					}, null, opts).lean();
					if (m?.timeStatus !== 'ACTIVE' || remaining(m) === 0 || !agent || !game || pending) {
					
						continue;
					}
					const setting = await getSettings(ctx, s.gameId);
                    if (await JackpotClient.findOne({ ...storeScope, gameId: s.gameId,
                        installationId: s.installationId }, null, opts).lean()) continue;
					const contribution = setting.settings.network.contributionPerMinute;
					
					
					const source = await Pool.findOne({ ...storeScope, gameId: s.gameId, poolType: 'SJ' }, null, opts).lean();
					
					if (contribution && source?.balance >= contribution) {
						await pool(ctx, s.gameId, 'SJ', -contribution); await pool(ctx, '_network', 'NETWORK', contribution);
						await ledger(ctx, 'network_contribution', contribution, { gameId: s.gameId, machineId: s.machineId, sessionId: s.sessionId, minute: p.minute });
					}
					candidates.push({ ...s,
						threshold: setting.settings.network.threshold, 
						machineNumber: m.machineNumber,
						rtpBps: s.state.totalBet ? Number(BigInt(s.state.totalWin) * 10000n / BigInt(s.state.totalBet)) : 0 
					
					});
				}
				candidates.sort((x, y) => x.rtpBps - y.rtpBps || new Date(x.lastNetworkAwardAt || 0) - new Date(y.lastNetworkAwardAt || 0) || x.machineNumber - y.machineNumber || x.installationId.localeCompare(y.installationId));
				const selected = candidates[0];
				const current = await Pool.findOne({ ...storeScope, gameId: '_network', poolType: 'NETWORK' }, null, opts).lean();
				if (selected && current?.balance >= selected.threshold) {
					await pool(ctx, '_network', 'NETWORK', -selected.threshold);
					const award = await reserveAward(ctx, selected, 'NETWORK', selected.threshold);
					await GameSession.updateOne({ ...storeScope, gameId: selected.gameId, sessionId: selected.sessionId }, { $set: { lastNetworkAwardAt: now } }, opts);

					await Audit.insertOne({ ...storeScope,
						dataId: geneRandomId(),
						action: 'network.selection',
						awardId: award.awardId,
						candidates: candidates.map(s => ({
							sessionId: s.sessionId,
							rtpBps: s.rtpBps,
							machineNumber: s.machineNumber
						})), 
						createdAt: now 
					}, opts);
					return award;
				}
				return { eligible: candidates.length, poolBalance: current?.balance || 0 };
			}
			default: throw new AppError('UNKNOWN_EVENT', 'Unsupported event', 404);
		}
	}
	async function reserveAward(ctx, s, type, amount, allFruit) {
		const award = {
			dataId: geneRandomId(),
			awardId: geneRandomId(), storeId: s.storeId, gameId: s.gameId, machineId: s.machineId,
			installationId: s.installationId, sessionId: s.sessionId, type, amount, allFruit, status: 'RESERVED'};
		await Award.insertOne(award, ctx.opts);
		await notify(ctx, room.installation(s), 'game.jackpot.awarded.v1', award);
		return award;
	}
	async function query(actor, kind, params = {}) {

		const scope = {
			storeId: actor.storeId
		
		};
		if (['audit', 'settlements', 'history', 'ledger', 'pools'].includes(kind)) {
			requireRole(actor, readers);
		}
		else {
			requireRole(actor, [...operators, 'READ_ONLY_AUDITOR']);
		
		}
		const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
		const extra = {};
		for (const key of ['gameId', 'machineId', 'cardId']) {
		
			if (params[key]) extra[key] = id.parse(params[key]);
		}
		if (kind === 'dashboard') {
			const machines = await Machine.find(scope).lean().exec();
			const sessions = await GameSession.find({ ...scope, status: 'ACTIVE' }).lean().exec();
			const presence = await Presence.find({ ...scope, connected: true, lastSeenAt: { $gt: new Date(Date.now() - 30000) } }).lean().exec();
			return clean({
				machines: machines.map(m => ({ ...m, remainingSeconds: remaining(m),
				connection: presence.some(p => p.machineId === m.machineId && p.role === 'DEVICE_TAS_C') ? 'ONLINE' : 'OFFLINE',
				runningGames: sessions.filter(s => s.machineId === m.machineId).map(s => ({ gameId: s.gameId, sessionId: s.sessionId })) })) });
		}
		const names = { machines: 'machines', games: 'games', cards: 'cards', sessions: 'sessions', pools: 'pools',
		settings: 'settings', audit: 'audit', ledger: 'ledger', history: 'periods', settlements: 'periods', commands: 'commands' };
		assert(names[kind], 'NOT_FOUND', 'Unknown query', 404);

		if (kind === 'settlements') extra.status = 'OPEN';
		if (kind === 'history') extra.status = 'CLOSED';
		if (params.before) extra.createdAt = {

			$lt: z.coerce.date().parse(params.before)
		};
		const results = await c(names[kind]).find({ ...scope, ...extra }, { _id: 0, cardUid: 0 }).lean().sort(kind === 'settings' ? { version: -1 } : { createdAt: -1 }).limit(limit).exec();
		if (actor.role === 'STORE_STAFF') return clean(results.map(item => {


			if (kind === 'sessions') return { gameId: item.gameId, machineId: item.machineId, sessionId: item.sessionId, status: item.status };
			if (kind === 'cards') return { cardId: item.cardId, displayNumber: item.displayNumber, status: item.status };
			return item;


		}));


		return clean(results);
	}
	return { dispatch, query };
}
