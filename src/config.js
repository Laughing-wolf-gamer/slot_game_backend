import 'dotenv/config';
import { z } from 'zod';

export function loadConfig(env = process.env) {
	const schema = z.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
		LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
		HOST: z.string().default('0.0.0.0'),
		PORT: z.coerce.number().int().min(0).max(65535).default(5000),
		
		MONGODB_URI: z.string().min(1),
		
		MONGODB_DATABASE: z.string().default('project_j_backend'),
		
		JWT_SECRET: z.string().min(32),
		
		CORS_ORIGINS: z.string().default('http://localhost:5173'),


		STORE_ID: z.string().min(1).default('store_demo'),


		HQ_VALIDATION_REQUIRED: z.enum(['true', 'false']).default('false'),
		HQ_URL: z.string().default(''),
		HQ_API_KEY: z.string().default(''),

		ALLOW_TEST_JACKPOT: z.enum(['true', 'false']).default('false')



	});
	const v = schema.parse(env);
	if (v.NODE_ENV === 'production' && v.JWT_SECRET.startsWith('replace-')) {
		throw new Error('Set a random JWT_SECRET');
	
	}
	if (v.NODE_ENV === 'production' && v.HQ_VALIDATION_REQUIRED !== 'true') {
		throw new Error('Production requires HQ validation');
	
	}
	if (v.HQ_VALIDATION_REQUIRED === 'true' && !v.HQ_URL.startsWith('https://')) {
	
		throw new Error('HQ_URL must use HTTPS');
	}
	return {
		environment: v.NODE_ENV, logLevel: v.LOG_LEVEL, host: v.HOST, port: v.PORT, mongoUri: v.MONGODB_URI,
		database: v.MONGODB_DATABASE, 
		jwtSecret: v.JWT_SECRET,
		storeId: v.STORE_ID,
		origins: v.CORS_ORIGINS.split(',').map(x => x.trim()).filter(Boolean),
		hqRequired: v.HQ_VALIDATION_REQUIRED === 'true', hqUrl: v.HQ_URL, hqKey: v.HQ_API_KEY,
		testJackpot: v.NODE_ENV !== 'production' && v.ALLOW_TEST_JACKPOT === 'true'
	};
}
