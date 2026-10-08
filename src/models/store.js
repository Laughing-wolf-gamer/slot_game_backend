import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String, required: false },
	storeId: { type: String, required: true },
	name: { type: String, required: false },
	timezone: { type: String, required: false },
	status: { type: String, required: true },
	serverSequence: { type: Number, required: false, validate: safeInteger, min: 0 },
	hqValidatedAt: { type: Date, required: false },
	hqValidUntil: { type: Date, required: false }
}, { collection: 'stores',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1}, {"unique":true});

validateWrites(schema);
const Store = mongoose.models.Store || mongoose.model('Store', schema);
export default Store;
