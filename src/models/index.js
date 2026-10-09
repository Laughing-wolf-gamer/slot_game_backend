import store from './store.js';
import user from './user.js';
import device from './device.js';
import machine from './machine.js';
import game from './game.js';
import card from './card.js';
import settings from './settings.js';
import session from './session.js';
import pool from './pool.js';
import award from './award.js';
import inbox from './inbox.js';
import period from './period.js';
import command from './command.js';
import refreshToken from './refresh-token.js';
import ledger from './ledger.js';
import audit from './audit.js';
import outbox from './outbox.js';
import presence from './presence.js';
import hqOutbox from './hq-outbox.js';
import jackpotClient from './jackpot-client.js';
import { createConsoleLogger } from '../common/logging.js';
const logger = createConsoleLogger();
export const models = Object.freeze(Object.fromEntries([
	store, user, device, machine, game, card, settings, session, pool, award, inbox,
	period, command, refreshToken, ledger, audit, outbox, presence, hqOutbox, jackpotClient
].map(model => [model.collection.name, model])));


export async function initializeModels(connection) {
	const bound = {};
	// logger.info(bound, "Intialized the models with connect: ");

	for (const [name, definition] of Object.entries(models)) {
		const Model = connection.model(definition.modelName, definition.schema, name);
		await Model.createCollection();
		await Model.createIndexes();

		bound[name] = Model;
	}

	return Object.freeze(bound);
}


