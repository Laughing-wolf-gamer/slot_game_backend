import { createConsoleLogger } from '../common/logging.js';
import Audit from '../models/audit.js';
import Command from '../models/command.js';
import HqOutbox from '../models/hq-outbox.js';
import Machine from '../models/machine.js';
import Outbox from '../models/outbox.js';
import Presence from '../models/presence.js';
import Store from '../models/store.js';
import { room, uid } from '../modules/backend.js';
const logger = createConsoleLogger();
export function createWorkers({ backend, config, io }) {
	let running = false;
	let timer;
	let pending = Promise.resolve();
	async function tick() {
		
		const outbox = await Outbox.find({
			status: 'PENDING'
		
		}).lean().sort({ createdAt: 1 }).limit(100).exec();
		// logger.info(outbox.length,"outbox pending");
		for (const row of outbox) {
			const namespace = row.room.endsWith(':admins') ? '/admin' : row.room.includes(':installation:') || row.room.includes(':game:') ? '/game' : '/agent';
			const ns = io.of(namespace);
			
			if (!ns.adapter.rooms.get(row.room)?.size) {
				continue;
			
			}
			ns.to(row.room).emit(row.eventName, {
				...row.payload,
				notificationId: row.dataId
			});
			const legacy = {'game.normal-win.assigned.v1': 'normal_winning', 'game.jackpot.awarded.v1': 'jackpot_awarded', 'game.pool.summary.v1': 'game_info' }[row.eventName];
			if (legacy) {

				ns.to(row.room).emit(legacy, row.payload);
			}
			await Outbox.updateOne({ _id: row._id, status: 'PENDING' }, { $set: { status: 'DELIVERED', deliveredAt: new Date() }, $inc: { attempts: 1 } });
		}
		await Presence.updateMany({ connected: true, lastSeenAt: { $lt: new Date(Date.now() - 30000) } }, { $set: { connected: false } });
		const stores = await Store.find({ status: 'ACTIVE' }).lean().exec();
		for (const store of stores) {
			const actor = {
				storeId: store.storeId,
				actorId: 'system',
				sourceId: 'system',
				role: 'SYSTEM'
			};
			const expired = await Machine.find({
				storeId: store.storeId,
				timeStatus: 'ACTIVE',
				deadline:{
					$lte: new Date()
				} 
			}).lean().exec();

			logger.info(expired?.length,`Expired Stroes Count`)
			for (const m of expired) {
				try {
					
					await backend.dispatch(actor, {
						eventId: `expire-${m.machineId}-${m.stateVersion}`, eventName: 'time.expire.internal', correlationId: uid(),
						payload: { machineId: m.machineId, expectedVersion: m.stateVersion, reason: 'Usage time expired' 
				
					} 
				});
				} catch (e) {
					if (!['STALE_VERSION', 'INVALID_STATE'].includes(e.code)){
						throw e;
					}
				
				}
			}
			const minute = Math.floor(Date.now() / 60000);
			await backend.dispatch(actor, { eventId: `network-${minute}`, eventName: 'network.tick.internal', correlationId: `network-${minute}`, payload: { minute } });
			const commands = await Command.find({ storeId: store.storeId, status: { $in: ['REQUESTED', 'ACKNOWLEDGED'] }, expiresAt: { $lte: new Date() } }).lean().exec();
			for (const command of commands) {
				const result = await Command.updateOne({ _id: command._id, status: { $in: ['REQUESTED', 'ACKNOWLEDGED'] } }, { $set: { status: 'TIMED_OUT', updatedAt: new Date() } });
				if (result.modifiedCount) {
					await Audit.insertOne({ dataId: uid(), storeId: store.storeId, action: 'command.timeout', commandId: command.commandId, createdAt: new Date() });
					io.of('/admin').to(room.admins(actor)).emit('command.timeout.v1', { commandId: command.commandId });
				}
			}
		}
		if (config.hqUrl) {
			const rows = await HqOutbox.find({ status: 'PENDING', $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] }).lean().limit(10).exec();
			for (const row of rows) {
				try {
				const response = await fetch(`${config.hqUrl}/events`, { method: 'POST', signal: AbortSignal.timeout(5000),
						headers: { authorization: `Bearer ${config.hqKey}`, 'content-type': 'application/json', 'idempotency-key': row.dataId },
						body: JSON.stringify({
							eventId: row.dataId,
							storeId: row.storeId,
							type: row.type,
							payload: row.payload
						}) 
					});
					if (!response.ok) {
					
						throw new Error('HQ rejected event');
					}
					await HqOutbox.updateOne({ _id: row._id }, { $set: { status: 'DELIVERED', deliveredAt: new Date() } });
				} catch {
					await HqOutbox.updateOne({ _id: row._id }, { $inc: { attempts: 1 }, $set: { nextAttemptAt: new Date(Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12))) } });
				}
			}
		}
	}
	function schedule() {
		timer = setTimeout(() => {
			pending = tick().catch(error => logger.error({ err: error }, 'Worker tick failed')).finally(() => {
				if (running){
					schedule();
				
				} 
			});
		}, 1000);
		timer.unref();
	}
	return {
			tick,
			start() {
			running = true;
			schedule();
		}, async stop() {
			running = false;
			clearTimeout(timer);
			await pending;
		} 
	};
}
