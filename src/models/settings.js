import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';
import { settingsSchema } from '../common/validation.js';

export const schema = new mongoose.Schema({
	dataId: {
		type: String,
		default:"",
	},
	storeId: {
		type: String,
		required: true
	
	},
	gameId: {
		type: String,
		required: true
	},
	version: {
		type: Number,
		required: true,
		validate: safeInteger,
		min: 0
	},
	settings: {
		type: new mongoose.Schema({

		smallJackpot: { type: new mongoose.Schema({
			percentageBps: {
				type: Number,
				required: true,
				validate: safeInteger,
				min: 0
			}
		}, { _id: false, strict: false, minimize: false }), required: true },
			mediumJackpot: {
			type: new mongoose.Schema({ percentageBps: {
				type: Number,
				required: true,
				validate: safeInteger,
				min: 0
			}
		}, { _id: false, strict: false, minimize: false }), required: true },
			bigJackpot: { type: new mongoose.Schema({
			percentageBps: {
				type: Number,
				required: true,
				validate: safeInteger,
			}
		}, { _id: false, strict: false, minimize: false }), required: true },
			normalWinning: {
				type: new mongoose.Schema({
				percentageBps: {
					type: Number,
					required: true,
					validate: safeInteger,
					min: 0
				}
		}, { _id: false, strict: false, minimize: false }), required: true },
		rtp: {
			type: new mongoose.Schema({
				targetBps: {
					type: Number,
					required: true,
					validate: safeInteger,
					min: 0 
				}
		}, { _id: false, strict: false, minimize: false }),required: true},

		commission: { type: new mongoose.Schema({
			enabled: { type: Boolean, required: true },
			percentageBps: {
				type: Number,
				required: true,
				validate: safeInteger,
				min: 0 
			}
		}, { _id: false, strict: false, minimize: false }), required: true },
		network: { type: new mongoose.Schema({
			contributionPerMinute: {
				type: Number,
				required: true,
				validate: safeInteger,
				min: 0
			},
			threshold: {
				type: Number,
				required: true,
				validate: safeInteger,
				min: 0
			}
		}, { _id: false, strict: false, minimize: false }), required: true}
		
	}, { _id: false, strict: false, minimize: false }), required: true }

}, {
	collection: 'settings',
	timestamps:true,
	versionKey: false,
	strict: false,
	minimize: false,
	autoCreate: false,
	autoIndex: false

});

schema.index({
	"storeId":1,
	"gameId":1,
	"version":1
}, {"unique":true});

schema.path('settings').validate(value => settingsSchema.safeParse(value?.toObject ? value.toObject() : value).success, 'Invalid game settings');

validateWrites(schema);

const Settings = mongoose.models.Setting || mongoose.model('Settings', schema);
export default Settings;
