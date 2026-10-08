import { loadConfig } from './config.js';
import { connectDatabase } from './common/database.js';
import { createApplication } from './app.js';
import { createConsoleLogger } from './common/logging.js';

let database;
let application;
const logger = createConsoleLogger();
try {
	const config = loadConfig();
	database = await connectDatabase(config);
	application = createApplication(database, config);
	
	const address = await application.listen();
	application.workers.start();
	logger.info(null,`Server running on Port ${address?.port}`);
	
	let stopping = false;
	async function shutdown() {
		if (stopping) return;
		stopping = true;
		const timeout = setTimeout(() => process.exit(1), 15000); 
		timeout.unref();
		try {
			await Promise.all([
				application.close(),
				await database.close()
			])
			clearTimeout(timeout); 
		}
		catch {
			process.exitCode = 1;
		}
	}
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
} catch (error) {
	console.error("Startup failed:",error);
	if (database) {

		await database.close();
	}
	process.exitCode = 1;
}
