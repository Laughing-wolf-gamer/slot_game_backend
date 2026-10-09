import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assert } from '../common/errors.js';
import { id, money, safeAdd } from '../common/validation.js';
import { requireRole } from '../common/auth.js';
import { selectUnityJackpot } from './unity-jackkpot.js';
import JackpotClient from '../models/jackpot-client.js';
import Pool from '../models/pool.js';
import Award from '../models/award.js';
import Session from '../models/session.js';
import Machine from '../models/machine.js';
import Presence from '../models/presence.js';
import { createConsoleLogger } from '../common/logging.js';

const logger = createConsoleLogger();



export const jpkeys = ['smallJackpot', 'mediumJackpot', 'bigJackpot'];
export const sharedpoolTypes = ['SHARED_SJ', 'SHARED_MJ', 'SHARED_BJ'];

const amounts = z.array(money.refine(n => n > 0)).min(1).max(1024);
const ranges = z.array(money).length(6).refine(a => [0, 2, 4].every(i => a[i] > 0 && a[i] <= a[i + 1]));

export const rulesSchema = z.object({
    theme: z.enum(['SevenSlot', 'Golf']), governmentBuild: z.boolean().optional(),
    minimumPools: z.array(money.refine(n => n > 0)).length(3),
    smallAmounts: amounts, mediumAmounts: amounts, bigAmounts: amounts,
    smallLevelRanges: ranges, mediumLevelRanges: ranges, bigLevelRanges: ranges
}).strict();

export function splitFunding(amount) {
    money.parse(amount);
    const shared = Number(BigInt(amount) * 80n / 100n);

    return { shared, local: amount - shared };
}

export function eligibleClient(client, session, machine, presence, now) {
    return !!(client.eligible && client.reportedAt && now - new Date(client.reportedAt) < 10000 &&
        session?.status === 'ACTIVE' && !session.activeDualAwardId && machine?.timeStatus === 'ACTIVE' &&
        new Date(machine.deadline) > now && presence?.connected && now - new Date(presence.lastSeenAt) < 15000);
}

export function createDualJackpot({ findSession, notify, room, remaining, ledger }) {
    async function changeShared(ctx, gameId, key, delta) {
        const poolType = sharedpoolTypes[jpkeys.indexOf(key)];
        assert(poolType, 'INVALID_PAYLOAD', 'Unknown shared jackpot pool');

        const filter = { storeId: ctx.actor.storeId, gameId, poolType };
        const row = await Pool.findOne(filter, null, ctx.opts).lean();
		// logger.info(row,"Pools rowss");
        const balance = safeAdd(row?.balance || 0, delta);
        await Pool.updateOne(filter, {

			$set: { balance }, $inc: { stateVersion: 1 },
            $setOnInsert: { dataId: randomUUID() }
			
		}, { ...ctx.opts, upsert: true });
    }
    async function cancelOffer(ctx, award) {
        if (!award || award.status !== 'OFFERED') {
			return;
		
		}
        await changeShared(ctx, award.gameId, award.poolKey, award.amount);
        await Award.updateOne({ storeId: award.storeId, awardId: award.awardId, status: 'OFFERED' },
            { $set: { status: 'CANCELLED' } }, ctx.opts);
        await notify(ctx, room.installation(award), 'game.jackpot.offer.cancelled.v1',
            { sessionId: award.sessionId, awardId: award.awardId });
    }
    async function reserve(ctx, s, selected, source, status) {

        const awardId = randomUUID();
        const award = { ...selected, dataId: awardId, awardId, eventId: awardId, source,
            storeId: s.storeId, gameId: s.gameId, machineId: s.machineId,
            installationId: s.installationId, sessionId: s.sessionId, gameplayMode: 'UNITY_LOCAL',
            status, expiresAt: status === 'OFFERED' ? new Date(ctx.now.getTime() + 15000) : undefined };
        await Award.insertOne(award, ctx.opts);

        return award;
    }
    async function handle(cntext) {
        const { actor: a, event: e, opts, now } = cntext;
        const p = e.payload;
        if (e.eventName === 'game.jackpot.shared.tick.internal') {
            requireRole(a, ['SYSTEM']);
			const awards = await Award.find({ storeId: a.storeId, source: 'SHARED', status: 'OFFERED',expiresAt: { $lte: now } }, null, opts).lean();
			// logger.info(awards,"awards")
            for (const expired of awards) {

				await cancelOffer(cntext, expired);
			
			}
            const clients = await JackpotClient.find({
				storeId: a.storeId,
				eligible: true,
                reportedAt: { $gt: new Date(now.getTime() - 10000) } }, null, opts).lean();
            const groups = new Map();
            for (const client of clients) {

                const s = await Session.findOne({ storeId: a.storeId, sessionId: client.sessionId }, null, opts).lean();
                const m = await Machine.findOne({ storeId: a.storeId, machineId: s?.machineId }, null, opts).lean();
                const presence = await Presence.findOne({
					storeId: a.storeId,
					installationId: client.installationId,
                    role: 'GAME_CLIENT',
					connected: true,
					lastSeenAt: { $gt: new Date(now.getTime() - 15000) } },
					null,
					opts
				).lean();
                const outstanding = await Award.findOne({ storeId: a.storeId, sessionId: client.sessionId,
                    status: { $in: ['OFFERED', 'RESERVED', 'ACKNOWLEDGED'] } }, null, opts).lean();
                if (!eligibleClient(client, s, m, presence, now) || outstanding) {
					continue;
				
				}
                if (!groups.has(client.gameId)){
					logger.error(null,"groupss gameid already preent");
					groups.set(client.gameId, []);
				}
                groups.get(client.gameId).push({ client, s });
            }
			logger.info(clients,"clients avaialbled");
            for (const [gameId, candidates] of groups) {
                const balances = {};
                for (let i = 0; i < jpkeys.length; i++) {

                    const row = await Pool.findOne({ storeId: a.storeId, gameId, poolType: sharedpoolTypes[i] }, null, opts).lean();
                    balances[jpkeys[i]] = row?.balance || 0;
                }
                
                while (candidates.length) {
                    const [{ client, s }] = candidates.splice(randomInt(candidates.length), 1);
                    const waiting = await Award.findOne({
						storeId: a.storeId,
						gameId, source: 'SHARED',
                        status: 'WAITING_FOR_FUNDS'

					}, null, opts).lean();
                    const selected = waiting || selectUnityJackpot(balances, client.rules);
                    if (!selected) {
						continue;
					
					}
                    if (balances[selected.poolKey] < selected.amount) {

                        if (!waiting) await reserve(cntext, s, selected, 'SHARED', 'WAITING_FOR_FUNDS');
                        break;
                    }
                    await changeShared(cntext, gameId, selected.poolKey, -selected.amount);
                    let award;
                    if (waiting) {

                        award = {
							...waiting,
							sessionId: s.sessionId,
							installationId: s.installationId,
                            machineId: s.machineId,
							status: 'OFFERED',

							expiresAt: new Date(now.getTime() + 15000)
						};

                        await Award.replaceOne({
							storeId: a.storeId,
							awardId: waiting.awardId
						
						}, award, opts);

                    } else {
						award = await reserve(cntext, s, selected, 'SHARED', 'OFFERED');
					}
                    await notify(cntext, room.installation(s), 'game.jackpot.offer.v1', award);
                    break;
                }
            }
            return {
				checked: clients.length
			};
        }
        requireRole(a, ['GAME_CLIENT']);

        const s = await findSession(
			cntext,
			id.parse(p.sessionId),
            e.eventName === 'game.jackpot.fund.v1' ? undefined : p.stateVersion
		);

        const machine = await Machine.findOne({
			storeId: a.storeId,
			machineId: a.machineId
		
		}, null, opts).lean();

		logger.info(machine?.length,"awailable machine");
        assert(
			s.status === 'ACTIVE' && machine?.timeStatus === 'ACTIVE' && remaining(machine) > 0,
            'SESSION_NOT_ACTIVE', 'Active gameplay time is required'
		);

        const scope = {
			storeId: a.storeId,
			gameId: a.gameId,
			installationId: a.installationId
		};
        const result = () => ({
			sessionId: s.sessionId,
			stateVersion: s.stateVersion
		
		});
        if (e.eventName === 'game.jackpot.fund.v1') {

            const input = z.object({
				sessionId: id,
				stateVersion: money,
                gross: z.object({

					smallJackpot: money,
					mediumJackpot: money,
					bigJackpot: money
				
				}).strict()
            }).strict().parse(p);

            for (const key of jpkeys) {

				await changeShared(cntext, a.gameId, key, splitFunding(input.gross[key]).shared);
			
			}
            s.gameplayPools ||= {
				smallJackpot: 0,
				mediumJackpot: 0,
				bigJackpot: 0,
                normalWinning: 0,
				rtp: 0,
				commission: 0
			};
            for (const key of jpkeys) {
				s.gameplayPools[key] = safeAdd(s.gameplayPools[key] || 0, splitFunding(input.gross[key]).local);
			
			}
            s.stateVersion++;
            await Session.replaceOne({ storeId: s.storeId, sessionId: s.sessionId }, s, opts);
            await JackpotClient.updateOne(scope, { $set: { localPools: s.gameplayPools } }, { ...opts, upsert: true });
            await ledger(cntext, 'shared_jackpot_contribution',
			jpkeys.reduce((n, key) => n + splitFunding(input.gross[key]).shared, 0),
			{
				sessionId: s.sessionId 
			});
            return result();
        }
        if (e.eventName === 'game.jackpot.eligibility.v1') {

            const input = z.object({
				sessionId: id,
				stateVersion: money,
				eligible: z.boolean(),
				rules: rulesSchema
			
			}).strict().parse(p);
            await JackpotClient.updateOne(scope, { $set: {
				sessionId: s.sessionId,
				eligible: input.eligible,
				reportedAt: now,
				rules: input.rules
			
			}, $setOnInsert: { localPools: s.gameplayPools || {} } }, { ...opts, upsert: true });
            const sharedPools = {};
            for (let i = 0; i < jpkeys.length; i++) {

                const row = await Pool.findOne({ storeId: a.storeId, gameId: a.gameId, poolType: sharedpoolTypes[i] }, null, opts).lean();
                sharedPools[jpkeys[i]] = row?.balance || 0;
            }
            return { ...result(), sharedPools };
        }
        if (e.eventName === 'game.jackpot.local.check.v1') {
            const input = z.object({ sessionId: id, stateVersion: money, rules: rulesSchema }).strict().parse(p);
            if (s.activeDualAwardId){
				return { ...result(), award: null };
			}
			logger.info(input,"game local jackpot check event");
            const existing = await Award.findOne({
				storeId: a.storeId,
				sessionId: s.sessionId,
                status: { $in: ['RESERVED', 'ACKNOWLEDGED'] } }, null, opts).lean();

            if (existing) {

				return { ...result(), award: existing.source === 'LOCAL' ? existing : null };
			}
            const client = await JackpotClient.findOne(scope, null, opts).lean();
            const selected = client?.waitingLocal || selectUnityJackpot(s.gameplayPools, input.rules);
			logger.info(selected,"game selected jackpot check event");
            if (!selected) {

				return { ...result(), award: null };
			}
            if ((s.gameplayPools?.[selected.poolKey] || 0) < selected.amount) {

                await JackpotClient.updateOne(scope, { $set: { waitingLocal: selected } }, { ...opts, upsert: true });
                return { ...result(), award: null };
            }
            const awards = await Award.find({ storeId: a.storeId, sessionId: s.sessionId, status: 'OFFERED' }, null, opts).lean();
			
            for (const offer of awards){

                await cancelOffer(cntext, offer);
			}
            s.gameplayPools[selected.poolKey] -= selected.amount;
			logger.debug(s.gameplayPools,"GAmepool updated");
            const award = await reserve(cntext, s, selected, 'LOCAL', 'RESERVED');
            s.activeDualAwardId = award.awardId;
            s.stateVersion++;

            await Session.replaceOne({ storeId: s.storeId, sessionId: s.sessionId }, s, opts);

            await JackpotClient.updateOne(scope, {
				$set: { localPools: s.gameplayPools, eligible: false },
                $unset: { waitingLocal: 1 } }, { ...opts, upsert: true });
            return { ...result(), award };
        }
        if (e.eventName === 'game.jackpot.offer.respond.v1') {


            const input = z.object({ sessionId: id, stateVersion: money, awardId: id, accept: z.boolean() }).strict().parse(p);
            const award = await Award.findOne({ ...scope, sessionId: s.sessionId, awardId: input.awardId }, null, opts).lean();
            assert(award && award.source === 'SHARED', 'INVALID_AWARD', 'Offer does not belong to this installation');
            if (award.status !== 'OFFERED'){
				return { ...result(), award: s.activeDualAwardId === award.awardId ? award : null };
			
			}
            if (!input.accept || s.activeDualAwardId || new Date(award.expiresAt) <= now) {

                await cancelOffer(cntext, award);
                return { ...result(), award: null };
            }
            const pending = await Award.findOne({
				storeId: a.storeId,
				sessionId: s.sessionId,
                status: { $in: ['RESERVED', 'ACKNOWLEDGED'] } }, null, opts).lean();
            if (pending) {
				await cancelOffer(cntext, award);
				return { ...result(), award: null };
			
			}
            award.status = 'RESERVED';
            s.activeDualAwardId = award.awardId;
            s.stateVersion++;
            await Award.updateOne({ ...scope, awardId: award.awardId }, { $set: { status: 'RESERVED' } }, opts);
            await Session.replaceOne({ storeId: s.storeId, sessionId: s.sessionId }, s, opts);
            await JackpotClient.updateOne(scope, { $set: { eligible: false } }, opts);
			
            return { ...result(), award };
        }
        assert(false, 'UNKNOWN_EVENT', 'Unsupported dual jackpot event');
    }
    return { handle };
}
