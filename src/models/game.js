import mongoose from 'mongoose';
import { safeInteger, validateWrites } from './shared.js';

export const schema = new mongoose.Schema({
	dataId: { type: String },
	storeId: { type: String, required: true },
	gameId: { type: String, required: true },
	name: { type: String },
	status: { type: String, required: true },
	
	reason: { type: String },


}, { collection: 'games',timestamps:true, versionKey: false, strict: false, minimize: false, autoCreate: false, autoIndex: false });

schema.index({"storeId":1,"gameId":1}, {"unique":true});

validateWrites(schema);

const Game = mongoose.models.Game || mongoose.model('Game', schema);
export default Game;
