import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String, required: false },
	storeId: { type: String, required: true },
	tokenHash: { type: String, required: true },
	userId: { type: String, required: true },
	expiresAt: { type: Date, required: true },
	revoked: { type: Boolean, required: true }
}, {
	collection: 'refreshTokens',
	timestamps:true,
	versionKey: false,
	strict: false,
	minimize: false,
	autoCreate: false,
	autoIndex: false
});

schema.index({"tokenHash":1}, {"unique":true});
schema.index({"expiresAt":1}, {"expireAfterSeconds":0});

validateWrites(schema);

const RefreshToken = mongoose.models.RefreshToken || mongoose.model('RefreshToken', schema);
export default RefreshToken;
