import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	commandId: { type: String, required: true },
	machineId: { type: String, required: true },
	type: { type: String, required: true },
	issuer: { type: String, required: true },
	status: { type: String, required: true },
	expiresAt: { type: Date, required: true },
	reason: { type: String, required: true },
	message: { type: String }
}, { collection: 'commands',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"commandId":1}, {"unique":true});

validateWrites(schema);

const Command = mongoose.models.Command || mongoose.model('Command', schema);
export default Command;
