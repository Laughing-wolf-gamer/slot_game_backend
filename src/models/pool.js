import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String, required: false },
	storeId: { type: String, required: true },
	gameId: { type: String, required: true },
	poolType: { type: String, required: true },
	balance: { type: Number, required: true, validate: safeInteger, min: 0, max: 1000000000000 },
	stateVersion: { type: Number, required: true, validate: safeInteger, min: 0 }
}, { collection: 'pools',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"gameId":1,"poolType":1}, {"unique":true});

validateWrites(schema);

const Pool = mongoose.models.Pool || mongoose.model('Pool', schema);
export default Pool;
