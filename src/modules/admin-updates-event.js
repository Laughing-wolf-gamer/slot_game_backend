import argon2 from 'argon2';
import { z } from 'zod';
import { assert } from '../common/errors.js';
import { id, money, version, reason, settingsSchema, defaultSettings } from '../common/validation.js';
import { owners, operators, requireRole } from '../common/auth.js';
import StoreConfig from '../models/store-config.js';
import MachineSettings from '../models/machine-settings.js';
import Machine from '../models/machine.js';
import Card from '../models/card.js';
import Session from '../models/session.js';
import Device from '../models/device.js';
import Settings from '../models/settings.js';
import Store from '../models/store.js';
import Audit from '../models/audit.js';
import Ledger from '../models/ledger.js';
import mongoose from 'mongoose';
import { createConsoleLogger } from '../common/logging.js';
const logger = createConsoleLogger();
export const historyCategories = {
    'tasc-usage': ['ledger', ['paid_time', 'time_change', 'card_time_usage']], 'card-usage': ['ledger', ['paid_time', 'game_deposit', 'player_exit', 'card_time_usage']],
    'task-usage': ['ledger', ['topup']], 'kiosk-transactions': ['ledger', ['topup']],
    'tasc-reset': ['ledger', ['machine_reset']], 'card-reset': ['ledger', ['card_reset']],
    'task-reset': ['ledger', ['kiosk_reset']], 'card-registration': ['ledger', ['card_registration']],
    'tasc-details': ['audit', null], 'card-transactions': ['ledger', null],
    'pc-status': ['ledger', ['machine_status', 'time_change']],
    'pc-payout': ['ledger', ['normal_win', 'jackpot_win', 'legacy_game_win', 'dual_jackpot_win']],
    'pc-accumulate': ['ledger', ['bet', 'network_contribution', 'shared_jackpot_contribution']],
    'pc-receive': ['audit', null], 'history-reset': ['ledger', ['history_reset']], 'activity': ['audit', null]
};

export async function historyQuery(actor, params) {
    requireRole(actor, [...operators, 'READ_ONLY_AUDITOR']);

    const entry = historyCategories[params.category];
    assert(entry, 'INVALID_PAYLOAD', 'Unknown history category');
	
    const filter = { storeId: actor.storeId };
    if (entry[1]) filter.type = { $in: entry[1] };

    for (const key of ['machineId', 'cardId', 'kioskId', 'gameId', 'actorId']) {

		if (params[key]) filter[key] = id.parse(params[key]);
	}
    if (params.action) {

		filter.action = z.string().max(128).parse(params.action);
	}
    const configuration = await readStoreConfig(actor.storeId);
    const from = params.from ? z.coerce.date().parse(params.from) : undefined;
    const boundary = params.includeArchived === 'true' ? undefined : configuration.historyResetAt;
    if (from || boundary || params.to || params.before) {

        filter.createdAt = {};
        if (from || boundary) {
			filter.createdAt.$gte = new Date(Math.max(from?.getTime() || 0, boundary?.getTime() || 0));
		}
        if (params.to) {
			filter.createdAt.$lte = z.coerce.date().parse(params.to);
		}
        if (params.before) {
			filter.createdAt.$lt = z.coerce.date().parse(params.before);
		}
    }
    if (params.cursor) {
        let cursor;
        try {
            const encoded = z.string().max(256).regex(/^[A-Za-z0-9_-]+$/).parse(params.cursor);
            cursor = z.object({ at: z.coerce.date(), id: z.string().regex(/^[a-f0-9]{24}$/i) }).strict()
                .parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
        } catch {
			assert(false, 'INVALID_PAYLOAD', 'Invalid history cursor');

		}
        filter.$or = [{
			createdAt: { $lt: cursor.at }
		
		}, {
			createdAt: cursor.at,
			_id: {
				$lt: new mongoose.Types.ObjectId(cursor.id)
				}
			
			}
		];
    }
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(params.limit);
    const records = await (entry[0] === 'ledger' ? Ledger : Audit).find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    const last = records.at(-1);
    const nextCursor = records.length === limit ? Buffer.from(JSON.stringify({ at: last.createdAt, id: String(last._id) })).toString('base64url') : null;

    return {
		category: params.category,
		historyResetAt: configuration.historyResetAt,
		nextCursor,
		records
	};
}

export const adminlistEvents = [
    'card.reset.v1', 'card.delete.v1', 'card.update.v1', 'admin-card.delete.v1',
    'store.environment.update.v1', 'store.fees.update.v1', 'store.password.update.v1',
    'store.password.verify.v1', 'history.reset.v1', 'activity.record.v1',
    'registry.machine.update.v1', 'registry.machine.delete.v1', 'machine.status.update.v1',
    'machine.reset.v1', 'kiosk.reset.v1', 'machine.settings.update.v1',
    'machine.settings.reset.v1', 'game.settings.reset.v1',
    'store.jackpots.update.v1', 'store.jackpots.reset.v1'
];

export const hexUid = z.string().trim().regex(/^(?:0x)?[0-9a-f]+$/i).max(128) .transform(value => value.replace(/^0x/i, '').toUpperCase());


const passwordKind = z.enum(['setup', 'lock', 'member', 'store']);
const password = z.string().min(12).max(256);

const environment = z.object({
    operatingPcs: z.number().int().min(0).max(10000).optional(),
	
    serverIp: z.union([z.ipv4(), z.ipv6()]).optional(),
    storeName: z.string().trim().min(1).max(128).optional(),
    timezone: z.string().max(100).optional()
}).strict();

export async function readStoreConfig(storeId, opts = {}) {
    return await StoreConfig.findOne({ storeId }, null, opts).lean() ||
        { storeId, stateVersion: 0, environment: {}, usageFees: {} };
}

export async function paidTimeAmount(storeId, machine, minutes, opts) {
    const config = await readStoreConfig(storeId, opts);
    const rate = machine.feePlan > 0 ? machine.feePlan : config.usageFees?.pointsPerMinute;
    assert(Number.isSafeInteger(rate) && rate > 0, 'FEE_REQUIRED', 'Configure a positive points-per-minute usage fee');
    return money.parse(rate * minutes);
}

export function createAdminDat({ ledger, notify, room, remaining }) {
    async function idleCard(ctx, cardId) {
        const scope = { storeId: ctx.actor.storeId, cardId };
        assert(!await Session.exists({ ...scope, recoverable: true }).session(ctx.opts.session),
            'CARD_IN_USE', 'Settle recoverable sessions before changing this card', 409);
        const machines = await Machine.find(scope, null, ctx.opts).lean();
        assert(!machines.some(m => remaining(m) > 0), 'CARD_IN_USE', 'Clear assigned machine time first', 409);
    }

    async function idleMachine(ctx, machineId) {
        const scope = { storeId: ctx.actor.storeId, machineId };
        assert(!await Session.exists({ ...scope, recoverable: true }).session(ctx.opts.session),
            'MACHINE_IN_USE', 'Settle recoverable sessions first', 409);
        return scope;
    }

    async function configUpdate(ctx, expectedVersion, changes) {
        const current = await readStoreConfig(ctx.actor.storeId, ctx.opts);
        assert(current.stateVersion === expectedVersion, 'STALE_VERSION', 'Configuration version changed', 409);
        await StoreConfig.updateOne({ storeId: ctx.actor.storeId }, {
			
            $set: { ...changes, stateVersion: expectedVersion + 1 }
        }, { ...ctx.opts, upsert: true });
        return readStoreConfig(ctx.actor.storeId, ctx.opts);
    }

    async function handle(ctx) {
        const { actor: a, event: e, opts, now } = ctx;
        const p = e.payload;
        const scope = { storeId: a.storeId };
        if (e.eventName === 'activity.record.v1') {

            requireRole(a, [...operators, 'DEVICE_TAS_C', 'DEVICE_TAS_K']);
            const input = z.object({ category: z.enum(['card-tapped', 'logged-in', 'status', 'validation', 'transaction', 'admin-activity']),
                cardId: id.optional(), success: z.boolean(),
                transactionMethod: z.enum(['CASH', 'CARD', 'OTHER']).optional(),
                validationSuccessCount: z.number().int().nonnegative().optional(),
                cashInjectionData: z.object({ denomination: money, count: z.number().int().positive().max(10000) }).strict().optional(),
                cardName: z.string().max(128).optional(),
				message: z.string().max(500).optional() 
			
			}).strict().parse(p);
			logger.info(input,"INput Update")
            if (input.cardId) {
				assert(await Card.exists({ ...scope, cardId: input.cardId }).session(opts.session), 'NOT_FOUND', 'Card missing', 404);
			}

            await Audit.insertOne({
				...scope,
				...input,
				action: `${a.role}.${input.category}`, actorId: a.actorId,
                sourceId: a.sourceId,
				machineId: a.machineId,
				kioskId: a.kioskId,
				eventId: e.eventId }, opts);
            return { recorded: true };
        }
        if (e.eventName === 'store.password.verify.v1') {
            requireRole(a, operators);
            const input = z.object({ kind: passwordKind, password: z.string().min(1).max(256) }).strict().parse(p);
            const config = await StoreConfig.findOne(scope, null, opts).select('+passwordHashes').lean();
            const hash = config?.passwordHashes?.[input.kind];
            assert(hash && await argon2.verify(hash, input.password), 'AUTH_REQUIRED', 'Invalid password', 401);
            return { verified: true, kind: input.kind };
        }
        requireRole(a, owners);
        switch (e.eventName) {
            case 'card.update.v1':
            case 'card.reset.v1':
            case 'card.delete.v1':
            case 'admin-card.delete.v1': {
                const input = z.object({
					cardId: id,
					expectedVersion: version,
					reason,

					timeMinutes: z.number().int().min(0).max(1000000).optional(),
                    points: money.optional(),
					displayNumber: z.string().max(32).optional(),

                    name: z.string().max(128).optional() }).strict().parse(p);
                if (e.eventName !== 'card.update.v1') {
					assert(['points', 'timeMinutes', 'displayNumber', 'name'].every(key => input[key] === undefined),
                    	'INVALID_PAYLOAD', 'Reset and delete accept only card identity, version and reason');
				}
                const card = await Card.findOne({ ...scope, cardId: input.cardId, status: 'ACTIVE' }, null, opts).lean();
				logger.info(card,"Found card to delete");

                assert(card, 'NOT_FOUND', 'Active card missing', 404);


                assert(card.stateVersion === input.expectedVersion, 'STALE_VERSION', 'Card version changed', 409);
                if (e.eventName === 'admin-card.delete.v1') assert(card.kind === 'ADMIN', 'INVALID_PAYLOAD', 'An admin card is required');
                await idleCard(ctx, card.cardId);


                const deletion = e.eventName.includes('delete');

                if (deletion) assert(card.points === 0 && !card.timeMinutes, 'BALANCE_REMAINING', 'Reset or reconcile remaining points and time first', 409);
                const points = e.eventName === 'card.reset.v1' ? 0 : input.points ?? card.points;
                const timeMinutes = e.eventName === 'card.reset.v1' ? 0 : input.timeMinutes ?? card.timeMinutes ?? 0;
                if (e.eventName === 'card.update.v1') {

					assert(input.points !== undefined || input.timeMinutes !== undefined || input.name !== undefined || input.displayNumber !== undefined, 'INVALID_PAYLOAD', 'Supply a card change');
				}
                if (points !== card.points || e.eventName === 'card.reset.v1') await ledger(ctx,
                    e.eventName === 'card.reset.v1' ? 'card_reset' : 'card_adjustment', points - card.points,
                    { cardId: card.cardId, cardDelta: points - card.points, balanceAfter: points, reason: input.reason });



                if (timeMinutes !== (card.timeMinutes || 0)) await ledger(ctx, 'card_time_adjustment', 0,
                    { cardId: card.cardId, seconds: (timeMinutes - (card.timeMinutes || 0)) * 60, reason: input.reason });


                const changes = { points, timeMinutes, stateVersion: card.stateVersion + 1, reason: input.reason,
                    ...(deletion ? { status: 'DELETED', deletedAt: now } : {}),
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.displayNumber !== undefined ? { displayNumber: input.displayNumber } : {}) };
                await Card.updateOne({ ...scope, cardId: card.cardId }, { $set: changes }, opts);
                return { ...card, ...changes };

            }
            case 'store.environment.update.v1': {
                const input = z.object({ expectedVersion: version, environment, reason }).strict().parse(p);
                const current = await readStoreConfig(a.storeId, opts);
				logger.info()

                const result = await configUpdate(ctx, input.expectedVersion, { environment: { ...current.environment, ...input.environment } });
                if (input.environment.timezone) {
					await Store.updateOne(scope, { $set: { timezone: input.environment.timezone } }, opts);
				}
                return result;
            }
            case 'store.fees.update.v1': {
                const input = z.object({ expectedVersion: version, pointsPerMinute: money.refine(n => n > 0), reason }).strict().parse(p);
                return configUpdate(ctx, input.expectedVersion, { usageFees: { pointsPerMinute: input.pointsPerMinute } });
            }
            case 'store.password.update.v1': {
                const input = z.object({ expectedVersion: version, kind: passwordKind, newPassword: password, reason }).strict().parse(p);
                const hash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
                return configUpdate(ctx, input.expectedVersion, { [`passwordHashes.${input.kind}`]: hash });
            }
            case 'history.reset.v1': {
                const input = z.object({ expectedVersion: version, reason }).strict().parse(p);
                const result = await configUpdate(ctx, input.expectedVersion, { historyResetAt: now });
                await ledger(ctx, 'history_reset', 0, { reason: input.reason });
                return result;
            }
            case 'store.jackpots.update.v1':
            case 'store.jackpots.reset.v1': {
                const share = z.object({ percentageBps: z.number().int().min(0).max(10000) }).strict();
                const allocations = z.object({
					smallJackpot: share,
					mediumJackpot: share,
					bigJackpot: share
				
				}).strict().refine(v => v.smallJackpot.percentageBps + v.mediumJackpot.percentageBps + v.bigJackpot.percentageBps === 10000);

                const input = z.object({ expectedVersion: version, allocations: allocations.optional(), reason }).strict().parse(p);

				
                assert(!await Session.exists({ ...scope, recoverable: true }).session(opts.session), 'SETTINGS_LOCKED', 'Recoverable sessions prevent total jackpot changes', 409);
                assert(e.eventName.includes('reset') || input.allocations, 'INVALID_PAYLOAD', 'Allocations required');


                const value = e.eventName.includes('reset') ? {
                    smallJackpot: defaultSettings.smallJackpot,
					mediumJackpot: defaultSettings.mediumJackpot,
					bigJackpot: defaultSettings.bigJackpot
                } : input.allocations;


                const config = await configUpdate(ctx, input.expectedVersion, { totalJackpot: value });
                const rows = await Settings.aggregate([{
					$match: scope }, { $sort: { version: -1 } },
                    { $group: { _id: '$gameId', latest: { $first: '$$ROOT' } } 
				
				}]).session(opts.session);
                for (const { latest } of rows) {
                    const next = {
						...scope,
						gameId: latest.gameId,
						version: latest.version + 1,
                        settings: { ...latest.settings, ...value }, reason: input.reason, actorId: a.actorId };
                    await Settings.insertOne(next, opts);


                    await notify(ctx, room.game(next), 'game.settings.updated.v1', next);
                }
                for (const override of await MachineSettings.find(scope, null, opts).lean()) {
					
                    const next = { ...override, version: override.version + 1, settings: { ...override.settings, ...value } };
                    await MachineSettings.replaceOne({ ...scope, gameId: override.gameId, machineId: override.machineId }, next, opts);
                    const base = rows.find(row => row.latest.gameId === next.gameId)?.latest;
                    await notify(ctx, room.machine(next), 'game.settings.updated.v1', { ...next,
                        version: base ? base.version + 1 : next.version, machineSettingsVersion: next.version });
                }
                return config;
            }
            case 'registry.machine.update.v1':
            case 'machine.status.update.v1': {
                const input = z.object({
					machineId: id,
					expectedVersion: version,
					reason,
                    machineNumber: z.number().int().positive().optional(), ipAddress: z.union([z.ipv4(), z.ipv6()]).optional(),
                    supplyDate: z.coerce.date().optional(),
					feePlan: money.refine(n => n > 0).optional(),

                    operationalStatus: z.enum(['IN_USE', 'STOPPED', 'UNUSED']).optional()
				
				}).strict().parse(p);

                const currentMachine = await Machine.findOne({ ...scope, machineId: input.machineId, status: { $ne: 'DELETED' } }, null, opts).lean();
				
                assert(currentMachine, 'NOT_FOUND', 'Machine missing', 404);
                assert(currentMachine.stateVersion === input.expectedVersion, 'STALE_VERSION', 'Machine version changed', 409);

                const { expectedVersion, reason: why, machineId, ...changes } = input;


                assert(Object.keys(changes).length > 0, 'INVALID_PAYLOAD', 'Supply a machine change');

                if (changes.operationalStatus === 'UNUSED') {
                    await idleMachine(ctx, machineId);

                    assert(remaining(currentMachine) === 0, 'MACHINE_IN_USE', 'Clear usage time first', 409);
                }
                if (changes.operationalStatus === 'STOPPED' && currentMachine.timeStatus === 'ACTIVE') {
                    changes.remainingSeconds = remaining(currentMachine);
					
					changes.timeStatus = 'PAUSED';
					
					changes.deadline = null;
                }
				logger.info(remaining(currentMachine),"machine")
                if (changes.operationalStatus === 'IN_USE') {
                    assert(remaining(currentMachine) > 0 && currentMachine.cardId, 'TIME_REQUIRED', 'Assigned card and usage time required');
                    changes.timeStatus = 'ACTIVE';

					changes.deadline = new Date(now.getTime() + remaining(currentMachine) * 1000);
                }
                const next = { ...currentMachine, ...changes, reason: why, stateVersion: currentMachine.stateVersion + 1 };
                await Machine.replaceOne({ ...scope, machineId }, next, opts);
                await ledger(ctx, 'machine_status', 0, { machineId, reason: why, operationalStatus: next.operationalStatus });
                await notify(ctx, room.machine(next), 'time.snapshot.v1', { ...next, remainingSeconds: remaining(next) });
                return next;
            }
            case 'machine.reset.v1':
            case 'registry.machine.delete.v1': {
                const input = z.object({ machineId: id, expectedVersion: version, reason }).strict().parse(p);
                const filter = await idleMachine(ctx, input.machineId);

                const machine = await Machine.findOne(filter, null, opts).lean();

                assert(machine && machine.status !== 'DELETED', 'NOT_FOUND', 'Machine missing', 404);
                assert(machine.stateVersion === input.expectedVersion, 'STALE_VERSION', 'Machine version changed', 409);
                assert(remaining(machine) === 0, 'MACHINE_IN_USE', 'Clear paid time before reset/deletion', 409);
                const next = {
					...machine,
					cardId: null,
					timeStatus: 'IDLE',
					deadline: null,
					remainingSeconds: 0,
                    operationalStatus: 'UNUSED',
					stateVersion: machine.stateVersion + 1,
					reason: input.reason,
                    ...(e.eventName.includes('delete') ? { status: 'DELETED', deletedAt: now } : {}) 
				
				};
                await Machine.replaceOne(filter, next, opts);
                if (next.status === 'DELETED') {
					await Device.updateMany(filter, { $set: { status: 'REVOKED', revokedAt: now } }, opts);
				}
                await ledger(ctx, 'machine_reset', 0, { machineId: machine.machineId, reason: input.reason });
                await notify(ctx, room.machine(next), 'time.snapshot.v1', next);


                return next;
            }
            case 'kiosk.reset.v1': {
                const input = z.object({ kioskId: id, reason }).strict().parse(p);
                assert(await Device.exists({ ...scope, kioskId: input.kioskId, role: 'DEVICE_TAS_K', status: 'ACTIVE' }).session(opts.session), 'NOT_FOUND', 'Kiosk missing', 404);
                await ledger(ctx, 'kiosk_reset', 0, { kioskId: input.kioskId, reason: input.reason });
                
                await notify(ctx, `store:${a.storeId}:kiosk:${input.kioskId}`, 'kiosk.reset.v1', { kioskId: input.kioskId, eventId: e.eventId });
                return { kioskId: input.kioskId, resetAt: now };
            }
            case 'machine.settings.update.v1':
            case 'machine.settings.reset.v1': {
                const input = z.object({ machineId: id, gameId: id, expectedVersion: version, settings: settingsSchema.optional(), reason }).strict().parse(p);
                assert(await Machine.exists({ ...scope, machineId: input.machineId, status: { $ne: 'DELETED' } }).session(opts.session), 'NOT_FOUND', 'Machine missing', 404);
                const base = await Settings.findOne({ ...scope, gameId: input.gameId }, null, { ...opts, sort: { version: -1 } }).lean();
                assert(base, 'NOT_FOUND', 'Game settings missing', 404);


                assert(!await Session.exists({ ...scope, machineId: input.machineId, recoverable: true }).session(opts.session), 'SETTINGS_LOCKED', 'Recoverable sessions prevent settings changes', 409);
                const filter = { ...scope, machineId: input.machineId, gameId: input.gameId };
                const current = await MachineSettings.findOne(filter, null, opts).lean();
                assert((current?.version || 0) === input.expectedVersion, 'STALE_VERSION', 'Settings version changed', 409);
                assert(e.eventName.includes('reset') || input.settings, 'INVALID_PAYLOAD', 'Settings required');
				
                const next = {
					...filter,
					settings: e.eventName.includes('reset') ? base.settings : input.settings,
                    version: input.expectedVersion + 1, actorId: a.actorId, reason: input.reason 
				
				};
                await MachineSettings.updateOne(filter, { $set: next }, { ...opts, upsert: true });
                await notify(ctx, room.machine(next), 'game.settings.updated.v1', { ...next, version: base.version, machineSettingsVersion: next.version });
                return next;
            }
            case 'game.settings.reset.v1': {

                const input = z.object({ gameId: id, expectedVersion: version, reason }).strict().parse(p);

                const old = await Settings.findOne({ ...scope, gameId: input.gameId }, null, { ...opts, sort: { version: -1 } }).lean();


                assert(old, 'NOT_FOUND', 'Game settings missing', 404);
                assert(old.version === input.expectedVersion, 'STALE_VERSION', 'Settings version changed', 409);

                assert(!await Session.exists({ ...scope, gameId: input.gameId, recoverable: true }).session(opts.session), 'SETTINGS_LOCKED', 'Recoverable sessions prevent settings changes', 409);
                const configuration = await readStoreConfig(a.storeId, opts);

                const next = {
					...scope,
					gameId: input.gameId,
					version: old.version + 1,
					settings: { ...defaultSettings, ...configuration.totalJackpot },
					actorId: a.actorId,
					reason: input.reason 
				
				};
                await Settings.insertOne(next, opts);

                await notify(ctx, room.game(next), 'game.settings.updated.v1', next);


                return next;
            }
        }
    }
    return { handle };
}
