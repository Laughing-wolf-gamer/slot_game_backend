import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: {
		type: String
	
	},
	storeId: { type: String, required: true },
	userId: { type: String, required: true },
	username: { type: String, required: true },
	passwordHash: { type: String, required: true },
	role: { type: String, required: true },
	status: { type: String, required: true },
	tokenVersion: { type: Number, required: true, validate: safeInteger, min: 0 },
	reason: {
		type: String
	
	}
	
}, { collection: 'users',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"username":1}, {"unique":true});

validateWrites(schema);

const User = mongoose.models.User || mongoose.model('User', schema);
export default User;
