import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: {
		type: String,
		defautl:null
		
	},
	storeId: {
		type: String,
		required: true
		
	},
	sessionId: {
		type: String,
		required: true
	
	},
	
	gameId: {
		type: String,
		required: true
	
	},
	machineId: {
		type: String,
		required: true
	
	},
	installationId: {
		type: String,
		required: true
	
	},
	cardId: { type: String, required: true },
	status: { type: String, required: true },
	recoverable: { type: Boolean, required: true },
	stateVersion: { type: Number, required: true, validate: safeInteger, min: 0 },
	clientSequence: {
		type: Number,
		required: true,
		validate: safeInteger,
		min: 0
	
	},
	state: { type: new mongoose.Schema({

		credit: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		bank: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		deposit: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		totalBet: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		totalWin: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		bet: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		freeSpins: {
			type: Number,
			required: true,
			validate: safeInteger,
			min:0
		
		}
	}, {
		_id: false,
		strict: false,
		minimize: false
	}), required: true },

	settingsVersion: {
		type: Number,
		required: true,
		validate: safeInteger,
		min: 0
	
	},
	appliedSettings: mongoose.Schema.Types.Mixed,
	machineSettingsVersion: { type: Number, validate: safeInteger, min: 1 },
	gameplayMode: {
		type: String,
		enum: ['UNITY_LOCAL'],
		required: false
	},
	gameplayPools: { type: new mongoose.Schema({
		smallJackpot: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		mediumJackpot: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		bigJackpot: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		normalWinning: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		rtp: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		},
		commission: {
			type: Number,
			required: true,
			validate: safeInteger,
			min: 0,
			max: 1000000000000
		
		}
	}, { _id: false, strict: true }), required: false },

	exitReason: {
		type: String,
		default:null	
	},
	lastNetworkAwardAt: {
		type: Date,
		default:new Date()
	},
	closedAt: {
		type: Date,
		required: false
	}
}, { collection: 'sessions', timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"gameId":1,"sessionId":1}, {"unique":true});
schema.index({"storeId":1,"installationId":1}, {"unique":true,"partialFilterExpression":{"recoverable":true}});

validateWrites(schema);
const GameSession = mongoose.models.GameSession || mongoose.model('GameSession', schema);
export default GameSession;
