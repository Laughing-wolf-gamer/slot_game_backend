import { createConsoleLogger } from '../common/logging.js';
import Audit from '../models/audit.js';
import Command from '../models/command.js';
import HqOutbox from '../models/hq-outbox.js';
import Machine from '../models/machine.js';
import Outbox from '../models/outbox.js';
import Presence from '../models/presence.js';
import Store from '../models/store.js';
import Award from '../models/award.js';
import User from '../models/user.js';
import RefreshToken from '../models/refresh-token.js';
import { room, geneRandomId } from '../modules/backend.js';
const logger = createConsoleLogger();
const adminRoles = ['STORE_OWNER', 'STORE_STAFF', 'READ_ONLY_AUDITOR', 'HQ_SUPER_ADMIN'];
function notificationNamespaces(row) {
	logger.debug(row,"notification namespace ");
    if (row.room.endsWith(':admins')) return ['/admin'];
    if (row.room.includes(':kiosk:')) return ['/kiosk'];
    if (row.room.includes(':installation:') || row.room.includes(':game:')) return ['/game'];
    
    if (row.eventName.startsWith('game.')) return ['/game'];
    return row.eventName === 'time.snapshot.v1' ? ['/agent', '/game'] : ['/agent'];
}
export function createWorkers({ backend, config, io }) {
	let running = false;
	let timer;
	let pending = Promise.resolve();
	async function timerTicks() {
		const now = new Date();
		const idleAdmins = await User.find({
			role: { $in: adminRoles },
			lockTime: { $type: 'date', $lte: now }
		}).select({ storeId: 1, userId: 1 }).lean().exec();
		for (const admin of idleAdmins) {
			const expired = await User.updateOne({
				storeId: admin.storeId,
				userId: admin.userId,
				role: { $in: adminRoles },
				lockTime: { $type: 'date', $lte: now }
			}, {
				$set: { lockTime: null },
				$inc: { tokenVersion: 1 }
			});
			if (!expired.modifiedCount) continue;
			await RefreshToken.updateMany({ storeId: admin.storeId, userId: admin.userId, revoked: false }, {
				$set: { revoked: true }
			});
			await Audit.insertOne({
				dataId: geneRandomId(),
				storeId: admin.storeId,
				actorId: admin.userId,
				action: 'auth.session.expired',
				reason: 'INACTIVITY'
			});
			for (const socket of io.of('/admin').sockets.values()) {
				if (socket.data.actor?.storeId === admin.storeId && socket.data.actor?.actorId === admin.userId) {
					socket.emit('auth.session.expired.v1', { reason: 'INACTIVITY' });
					socket.disconnect(true);
				}
			}
		}

        const deliveryRoutes = [];
        for (const name of ['/admin', '/game', '/agent', '/kiosk']) {
            const rooms = [...io.of(name).adapter.rooms].filter(([, sockets]) => sockets.size).map(([room]) => room);
            const primary = rooms.filter(room => name === '/admin' ? room.endsWith(':admins') :
                name === '/game' ? room.includes(':installation:') || room.includes(':game:') :
                name === '/kiosk' ? room.includes(':kiosk:') :
                !room.endsWith(':admins') && !room.includes(':installation:') && !room.includes(':game:') && !room.includes(':kiosk:'));
            if (primary.length) {
				deliveryRoutes.push({ room: { $in: primary } });
			
			}
            if (name === '/game') {
                const machineRooms = rooms.filter(room => room.includes(':machine:'));
                if (machineRooms.length) deliveryRoutes.push({ room: { $in: machineRooms }, eventName: { $in: ['time.snapshot.v1', 'game.settings.updated.v1'] } });
            }
        }
		const outbox = deliveryRoutes.length ? await Outbox.find({
			status: 'PENDING', $or: deliveryRoutes
		
		}).lean().sort({ createdAt: 1, _id: 1 }).limit(100).exec() : [];
		// logger.info(outbox.length,"outbox pending");
		for (const row of outbox) {
            const namespaces = notificationNamespaces(row).map(name => io.of(name))
                .filter(ns => ns.adapter.rooms.get(row.room)?.size);
			if (!namespaces.length) {
				continue;
			
			}
            if (row.eventName === 'game.jackpot.offer.v1') {
                const current = await Award.exists({ storeId: row.storeId, awardId: row.payload.awardId,
                    status: 'OFFERED', expiresAt: { $gt: new Date() } });
                if (!current) {
                    await Outbox.updateOne({ _id: row._id, status: 'PENDING' },
                        { $set: { status: 'DISCARDED' } });
                    continue;
                }
            }
            for (const ns of namespaces) {
			ns.to(row.room).emit(row.eventName, {
				...row.payload,
				notificationId: row.dataId
			});
			const legacy = {'game.normal-win.assigned.v1': 'normal_winning', 'game.jackpot.awarded.v1': 'jackpot_awarded', 'game.pool.summary.v1': 'game_info' }[row.eventName];
			if (legacy) {

				ns.to(row.room).emit(legacy, row.payload);
			}
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

			// logger.info(expired?.length,`Expired Stroes Count`)
			for (const m of expired) {
				try {
					
					await backend.dispatch(actor, {
						eventId: `expire-${m.machineId}-${m.stateVersion}`, eventName: 'time.expire.internal', correlationId: geneRandomId(),
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
            const tickSlot = Math.floor(Date.now() / 2000);
            await backend.dispatch(actor, { eventId: `shared-jp-${tickSlot}`,
                eventName: 'game.jackpot.shared.tick.internal', payload: {} });
			await backend.dispatch(actor, { eventId: `network-${minute}`, eventName: 'network.tick.internal', correlationId: `network-${minute}`, payload: { minute } });
			const commands = await Command.find({ storeId: store.storeId, status: { $in: ['REQUESTED', 'ACKNOWLEDGED'] }, expiresAt: { $lte: new Date() } }).lean().exec();
			for (const command of commands) {
				const result = await Command.updateOne({ _id: command._id, status: { $in: ['REQUESTED', 'ACKNOWLEDGED'] } }, { $set: { status: 'TIMED_OUT'} });
				if (result.modifiedCount) {
					await Audit.insertOne({ dataId: geneRandomId(), storeId: store.storeId, action: 'command.timeout', commandId: command.commandId });
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
			pending = timerTicks().catch(error => logger.error({ err: error }, 'Worker tick failed')).finally(() => {
				if (running){
					schedule();
				
				} 
			});
		}, 1000);
		timer.unref();
	}
	return {
			tick: timerTicks,
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
