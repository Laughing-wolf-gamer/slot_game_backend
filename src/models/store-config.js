import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

const schema = new mongoose.Schema({
    storeId: { type: String, required: true },

    stateVersion: { type: Number, required: true, validate: safeInteger, min: 1 },
    environment: { type: mongoose.Schema.Types.Mixed, default: {} },
    usageFees: { pointsPerMinute: { type: Number, validate: safeInteger, min: 1 } },
	
    totalJackpot: mongoose.Schema.Types.Mixed,
    passwordHashes: { type: Map, of: String, select: false },
    historyResetAt: Date
}, {collection: 'storeConfigs', timestamps: true, versionKey: false, strict: true });

schema.index({ storeId: 1 }, { unique: true });
validateWrites(schema);


const StoreConfig =  mongoose.models.StoreConfig || mongoose.model('StoreConfig', schema);
export default StoreConfig;
