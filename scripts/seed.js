import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/common/database.js';
import { defaultSettings } from '../src/common/validation.js';

const config = loadConfig();
if (!process.env.SEED_OWNER_PASSWORD || process.env.SEED_OWNER_PASSWORD.length < 12) {
	throw new Error('Set SEED_OWNER_PASSWORD (at least 12 characters)');

}
if (!process.env.SEED_DEVICE_SECRET || process.env.SEED_DEVICE_SECRET.length < 24) {
	throw new Error('Set SEED_DEVICE_SECRET (at least 24 characters)');

}
if (config.environment === 'production') {
	throw new Error('Demo seed is disabled in production; use controlled provisioning');

}
const database = await connectDatabase(config);
try {
	const storeId = config.storeId;
	const now = new Date();
	const defaultMachineTimeSeconds = 7 * 24 * 60 * 60;
	const rows = {
		stores: [{
			storeId,
			name: 'Project Demo Store',
			// timezone: 'Asia/India',
			status: 'ACTIVE',
			serverSequence: 0
		
		}],
		users: [{
			storeId,
			userId: 'owner_demo',
			username: 'owner',
			role: 'STORE_OWNER',
			status: 'ACTIVE',
			tokenVersion: 1,
		passwordHash: await argon2.hash(process.env.SEED_OWNER_PASSWORD, { type: argon2.argon2id }) }],

		machines: [{
			storeId,
			machineId: 'pc_001',
			machineNumber: 1,
			cardId: 'demo_card',
			timeStatus: 'ACTIVE',

			deadline: new Date(now.getTime() + defaultMachineTimeSeconds * 1000),
			remainingSeconds: defaultMachineTimeSeconds,
			stateVersion: 1,
			feePlan: 0
		
		}],
		games: [{ storeId, gameId: 'seven_slot', name: 'Seven Slot', status: 'ACTIVE' }],
		settings: [{ storeId, gameId: 'seven_slot', version: 1, settings: defaultSettings }],
		cards: [{ storeId, cardId: 'demo_card', cardUid: 'demo_card_uid', displayNumber: '1234', status: 'ACTIVE', points: 0, stateVersion: 1 }],
		devices: []
	};
	const secretHash = await argon2.hash(process.env.SEED_DEVICE_SECRET, { type: argon2.argon2id });
	rows.devices.push(
		{ storeId, deviceId: 'unity_001', role: 'GAME_CLIENT', gameId: 'seven_slot', machineId: 'pc_001', installationId: 'installation_001', secretHash, status: 'ACTIVE' },
		{ storeId, deviceId: 'agent_001', role: 'DEVICE_TAS_C', machineId: 'pc_001', secretHash, status: 'ACTIVE' },
		{ storeId, deviceId: 'kiosk_001', role: 'DEVICE_TAS_K', kioskId: 'kiosk_001', secretHash, status: 'ACTIVE' });
	const keys = {
		stores: ['storeId'],
		users: ['storeId', 'username'],
		machines: ['storeId', 'machineId'],
		games: ['storeId', 'gameId'],
		settings: ['storeId', 'gameId', 'version'],
		cards: ['storeId', 'cardId'],
		devices: ['storeId', 'deviceId']
	};
	for (const [name, values] of Object.entries(rows)) for (const value of values) {
		const filter = Object.fromEntries(keys[name].map(key => [key, value[key]]));
		const Model = database.models[name];
		if (!Model) {
			throw new Error(`Missing model for collection: ${name}`);
		}

		const record = new Model({
			...value,
			dataId: randomUUID(),
		});
		await record.validate();
		const document = record.toObject();
		
		await Model.updateOne(filter,
		{
			$setOnInsert: document
		}, {
			upsert: true,
			runValidators: true,
			setDefaultsOnInsert: false
		});
	}
	console.log('Seeded demo store, owner, machine, card, game, and three devices. Existing records preserved.');
} finally {
	await database.close(); 

}
