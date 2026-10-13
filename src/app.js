import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createAuth } from './common/auth.js';
import { createBackend } from './modules/backend.js';
import { createHttp } from './transports/http.js';
import { attachSockets } from './transports/socket.js';
import { createWorkers } from './workers/index.js';
import { createConsoleLogger } from './common/logging.js';



export function createApplication(database,config, logger = createConsoleLogger()) {
	const auth = createAuth(config, database);
	const backend = createBackend(database, config, logger);
	const dependencies = { config, database, auth, backend };
	const app = createHttp(dependencies);
	const http = createServer(app);
	const io = new Server(http, { cors: { origin: config.origins }, 
		allowEIO3: true,
		maxHttpBufferSize: 131072,
		pingInterval: 5000,
		pingTimeout: 15000,
		allowRequest: (req, done) => done(null, !req.headers.origin || config.origins.includes(req.headers.origin)) 
	});
	const sockets = attachSockets(io, dependencies);
	const workers = createWorkers({ ...dependencies, io });
	return {
		app,
		http,
		io,
		auth,
		backend,
		workers,
		listen: () => new Promise((resolve, reject) => {
			http.once('error', reject); 
			http.listen(config.port, config.host,
			
			() => {
				http.removeListener('error', reject);
				resolve(http.address()); 
			}); 
		}),
		async close() {
			await workers.stop();
			await new Promise(resolve => io.close(resolve)); 
			await sockets.drain();
		} 
	};
}
