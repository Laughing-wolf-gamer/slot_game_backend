import mongoose from 'mongoose';
import { validateWrites } from './shared.js';

const schema = new mongoose.Schema({
    storeId: { type: String, required: true },
    gameId: { type: String, required: true },
    installationId: { type: String, required: true },
    sessionId: String,
    localPools: mongoose.Schema.Types.Mixed,
    eligible: { type: Boolean, default: false },
    reportedAt: {type:Date,default:new Date()},
    rules: mongoose.Schema.Types.Mixed,
    waitingLocal: mongoose.Schema.Types.Mixed

}, { collection: 'jackpotClients', timestamps: true, versionKey: false });


schema.index({ storeId: 1, gameId: 1, installationId: 1 }, { unique: true });
validateWrites(schema);

const JackpotClient = mongoose.models.JackpotClient || mongoose.model('JackpotClient', schema);
export default JackpotClient;
