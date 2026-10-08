import { randomBytes, createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { assert, AppError } from './errors.js';
import { id } from './validation.js';
import { createConsoleLogger } from './logging.js';
import Store from '../models/store.js';
import User from '../models/user.js';
import RefreshToken from '../models/refresh-token.js';
import Audit from '../models/audit.js';
import Device from '../models/device.js';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function requireRole(actor, roles) {
	assert(
		roles.includes(actor.role),
		'FORBIDDEN',
		'Permission denied',
		403
	);
}

export const owners = ['STORE_OWNER', 'HQ_SUPER_ADMIN'];
export const operators = [...owners, 'STORE_STAFF'];
export const readers = [...owners, 'READ_ONLY_AUDITOR'];

const logger = createConsoleLogger();

export function createAuth(config) {

	const issue = actor => jwt.sign(actor, config.jwtSecret, { expiresIn: '60m', issuer: 'project-j', audience: 'project-j-clients' });
	async function access(input) {
		try {
			const claims = jwt.verify(input, config.jwtSecret, { issuer: 'project-j', audience: 'project-j-clients', algorithms: ['HS256'] });
			const user = await User.findOne({ storeId: claims.storeId, userId: claims.actorId, status: 'ACTIVE' }).lean();
			assert(user && user.tokenVersion === claims.tokenVersion, 'AUTH_REQUIRED', 'Credential revoked', 401);
			await entitlement(claims.storeId);
			return { 
				actorId: user.userId, 
				sourceId: user.userId,
				storeId: user.storeId,
				role: user.role,
				tokenVersion: user.tokenVersion 
			};
		} catch (e) {
			if (e instanceof AppError){
				throw e;
			}
			throw new AppError('AUTH_REQUIRED', 'Invalid or expired access token', 401); 
		}
	}
	async function entitlement(storeId) {
		const store = await Store.findOne({ storeId, status: 'ACTIVE' }).lean();
		assert(store, 'FORBIDDEN', 'Store access is blocked', 403);
		if (config.hqRequired) {
			assert(store.hqValidUntil && store.hqValidUntil > new Date(), 'FORBIDDEN', 'HQ validation has expired', 403);
		
		}
	}
	async function validateHQ(storeId) {
		if (!config.hqRequired) return;
		const store = await Store.findOne({ storeId }).lean();
		if (store?.hqValidUntil > new Date() && store.status === 'ACTIVE') {

			return;
		
		}
		let response;
		try {
			response = await fetch(`${config.hqUrl}/stores/${encodeURIComponent(storeId)}/validate`, {
				method: 'POST',
				headers:
				{
					authorization: `Bearer ${config.hqKey}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ storeId }),
				signal: AbortSignal.timeout(5000)
			});
		} catch {
		
			throw new AppError('HQ_UNAVAILABLE', 'HQ validation unavailable', 503); 
		}
		assert(response.ok, 'FORBIDDEN', 'HQ validation rejected', 403);
		const result = z.object({
			active: z.boolean(),
			validUntil: z.iso.datetime()
		}).parse(await response.json());

		const validUntil = new Date(result.validUntil);
		assert(result.active && validUntil > new Date(), 'FORBIDDEN', 'HQ access blocked', 403);
		await Store.updateOne({ storeId }, { $set: { hqValidatedAt: new Date(), hqValidUntil: new Date(Math.min(validUntil.getTime(), Date.now() + 86400000)) } });
	}
	async function tokens(user) {
		const refreshToken = randomBytes(48).toString('base64url');
		await RefreshToken.insertOne({
			dataId: randomUUID(),
			tokenHash: hashToken(refreshToken),
			storeId: user.storeId,
			userId: user.userId, createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400000), revoked: false 
		});
		return { accessToken: issue({
			actorId: user.userId,
			storeId: user.storeId,
			role: user.role,
			tokenVersion: user.tokenVersion 
		}), refreshToken, expiresIn: 900 };
	}
	async function login(input) {
		const data = z.object({ storeId: id, username: id, password: z.string().min(1).max(256) }).strict().parse(input);
		const user = await User.findOne({ storeId: data.storeId, username: data.username, status: 'ACTIVE' }).lean();
		const valid = user && await argon2.verify(user.passwordHash, data.password);

		await Audit.insertOne({
			dataId: randomUUID(),
			storeId: data.storeId,
			action: valid ? 'auth.login' : 'auth.login.failed',
			actorId: user?.userId,
			createdAt: new Date()
		
		});

		assert(valid, 'AUTH_REQUIRED', 'Invalid credentials', 401);
		await validateHQ(user.storeId);
		await entitlement(user.storeId);
		return tokens(user);
	}
	async function refresh(input) {
		const { refreshToken } = z.object({ refreshToken: z.string().min(32).max(256) }).strict().parse(input);
		const old = await RefreshToken.findOneAndUpdate({
			tokenHash: hashToken(refreshToken), revoked: false, expiresAt: { $gt: new Date() } }, { $set: { revoked: true } }, { returnDocument: 'before' }).lean();
		assert(old, 'AUTH_REQUIRED', 'Invalid refresh token', 401);
		const user = await User.findOne({ storeId: old.storeId, userId: old.userId, status: 'ACTIVE' }).lean();
		assert(user, 'AUTH_REQUIRED', 'User inactive', 401);

		await validateHQ(user.storeId);
		await entitlement(user.storeId);

		return tokens(user);
	}
	async function device(input, role) {
		const data = z.object({ storeId: id, deviceId: id, secret: z.string().min(16).max(256) }).parse(input);
		const row = await Device.findOne({ storeId: data.storeId, deviceId: data.deviceId, role, status: 'ACTIVE' }).lean();
		const context = { storeId: data.storeId, deviceId: data.deviceId, role };
		logger?.debug({
			...context,
			stage: 'authentication.device.lookup',
			found: Boolean(row)
		},'Active device lookup completed');
		const verified = Boolean(row && await argon2.verify(row.secretHash, data.secret));
		if (!verified) {
			logger?.warn({ ...context, stage: 'authentication.device.verify', reason: row ? 'secret_mismatch' : 'active_device_not_found' }, 'Device credential verification failed');
		
		}
		assert(verified, 'AUTH_REQUIRED', 'Invalid device credential', 401);
		const store = await Store.findOne({
			storeId: row.storeId,
			status: 'ACTIVE'
		}).lean();
		logger?.debug({ ...context, stage: 'authentication.store.lookup', active: Boolean(store) }, 'Store access checked');
		assert(store, 'FORBIDDEN', 'Store blocked', 403);
		return { actorId: row.deviceId, sourceId: row.deviceId, storeId: row.storeId, role: row.role,
		machineId: row.machineId, gameId: row.gameId, installationId: row.installationId, kioskId: row.kioskId };
	}
	async function activeDevice(actor) {
		assert(await Device.findOne({
			storeId: actor.storeId,
			deviceId: actor.actorId,
			status: 'ACTIVE',
			role: actor.role
		
		}).lean(), 'AUTH_REQUIRED', 'Device revoked', 401);
		assert(await Store.findOne({
			storeId: actor.storeId,
			status: 'ACTIVE'
		
		}).lean(), 'FORBIDDEN', 'Store blocked', 403);
	}
	return { access, login, refresh, device, activeDevice, entitlement,
		logout: async input => {
		const { refreshToken } = z.object({
			refreshToken: z.string().min(32).max(256)
		
		}).strict().parse(input);
		await RefreshToken.updateOne({
			tokenHash: hashToken(refreshToken)
		}, {
			$set: {
				revoked: true 
			} 
		});
		return {
			loggedOut: true
		};
	}};
}
