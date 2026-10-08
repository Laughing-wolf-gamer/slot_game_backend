import mongoose from 'mongoose';
import { initializeModels } from '../models/index.js';
import { createConsoleLogger } from './logging.js';

export async function connectDatabase(config) {
	const logger = createConsoleLogger();
	const connection = mongoose.connection;
	try {
		await mongoose.connect(config.mongoUri, {
			dbName: config.database,
			serverSelectionTimeoutMS: 10000,
			autoCreate: false,
			autoIndex: false
		});
		const models = await initializeModels(connection);

		logger.info(null, `Connected to DB: ${connection.host}`);
		return {
			connection, models, db: connection.db, transaction: fn => connection.transaction(fn, {

				readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary'
			}), close: () => mongoose.disconnect()
		};
	} catch (error) {
		await mongoose.disconnect();
		logger.error(error, 'Error connecting to MongoDB:');
		throw error;
	}
}
