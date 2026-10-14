import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHttp } from '../src/transports/http.js';
import { defaultSettings } from '../src/common/validation.js';
import { historyCategories, adminlistEvents } from '../src/modules/admin-updates-event.js';
import { legacyEvents } from '../src/transports/socket.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const store = '/api/v1/stores/:storeId';
const owner = 'STORE_OWNER or HQ_SUPER_ADMIN';
const operator = 'STORE_OWNER, HQ_SUPER_ADMIN or STORE_STAFF';
const reader = 'STORE_OWNER, HQ_SUPER_ADMIN or READ_ONLY_AUDITOR';
const viewer = `${operator}, or READ_ONLY_AUDITOR`;
const variables = {
    baseUrl: 'http://localhost:5000', storeId: 'store_demo', username: 'owner', password: '',
    accessToken: '', refreshToken: '', newPassword: '', storePassword: '', newStorePassword: '',
    newAdminUsername: 'store_admin_001', newAdminPassword: '', adminUserId: '',
    machineId: 'pc_001', machineNumber: '1', cardId: 'card_001', adminCardId: 'admin_card_001',
    cardUid: 'DEADBEEF', gameId: 'seven_slot', deviceId: 'unity_001', agentDeviceId: 'agent_001',
    kioskDeviceId: 'kiosk_001', deviceSecret: '', installationId: 'installation_001', kioskId: 'kiosk_001',
    sessionId: '', actorId: 'operator_001', reason: 'Postman operator action', eventId: '', lastEventId: '',
    configVersion: '0', machineVersion: '1', cardVersion: '1', adminCardVersion: '1',
    settingsVersion: '1', machineSettingsVersion: '0', historyCategory: 'card-usage',
    passwordKind: 'setup', from: '', to: '', before: '', historyCursor: '', hqCursor: '',
    hqHomeStoreId: 'store_demo', hqStoreId: 'store_demo', hqUsername: 'hq_admin', hqPassword: '',
    hqAccessToken: '', hqRefreshToken: '', hqMachineId: 'hq_pc_001', hqMachineVersion: '1'
};
const groups = new Map();
const definitions = [];
function add(folder, method, route, title, description, options = {}) {
    const definition = { folder, method, route, title, description, ...options };
    definitions.push(definition);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(definition);
}
const change = (versionName, extra = {}) => ({ expectedVersion: `{{${versionName}}}`, reason: '{{reason}}', ...extra });
const settings = () => structuredClone(defaultSettings);
const machine = () => ({ machineId: '{{machineId}}', machineNumber: 1, feePlan: 10, ipAddress: '127.0.0.1', supplyDate: '2026-10-14T00:00:00.000Z', reason: '{{reason}}' });
const gameDevice = () => ({ deviceId: '{{deviceId}}', role: 'GAME_CLIENT', machineId: '{{machineId}}', gameId: '{{gameId}}', installationId: '{{installationId}}', secret: '{{deviceSecret}}', reason: '{{reason}}' });
const filters = ['limit', 'gameId', 'machineId', 'cardId', 'kioskId', 'type', 'action', 'from', 'to', 'before'];
const query = (keys) => keys.map(key => ({ key, value: key === 'limit' ? '100' : key === 'type' ? 'topup' : key === 'action' ? 'auth.login' : `{{${key}}}`, disabled: key !== 'limit', description: key === 'limit' ? 'Maximum records; 1–500, default 100.' : 'Optional filter. Enable and set a value before sending.' }));

add('00 Health', 'GET', '/health/live', 'Liveness — server process', 'Checks whether the HTTP server is running. Does not check MongoDB.', { public: true, sample: { status: 'UP' } });
add('00 Health', 'GET', '/health/ready', 'Readiness — MongoDB connection', 'Pings MongoDB. Returns 200 READY or 503 DATABASE_UNAVAILABLE.', { public: true, sample: { status: 'READY' } });
add('01 Authentication', 'POST', '/api/v1/auth/login', 'Log in — store administrator', 'Required: storeId, username, password. Verifies active user/store and configured HQ entitlement. Captures accessToken and refreshToken; access lifetime is 3600 seconds.', { public: true, body: { storeId: '{{storeId}}', username: '{{username}}', password: '{{password}}' }, captureTokens: 'store', sample: { ok: true, data: { accessToken: '<access-token>', refreshToken: '<refresh-token>', expiresIn: 3600 } } });
add('01 Authentication', 'POST', '/api/v1/auth/refresh', 'Refresh — rotate administrator tokens', 'Required: refreshToken. Consumes the old refresh token and issues a new token pair. Captures both replacements.', { public: true, body: { refreshToken: '{{refreshToken}}' }, captureTokens: 'store' });
add('01 Authentication', 'POST', '/api/v1/auth/logout', 'Log out — revoke refresh token', 'Required: refreshToken. Revokes that refresh token; an already-issued access token remains valid until expiry or tokenVersion invalidation.', { public: true, body: { refreshToken: '{{refreshToken}}' }, sample: { ok: true, data: { loggedOut: true } }, clearRefresh: true });
add('01 Authentication', 'POST', '/api/v1/auth/verify-password', 'Verify current administrator password', 'Required: password. Verifies the authenticated user password and audits the result. Returns {verified:true}.', { body: { password: '{{password}}' }, role: 'Any active authenticated administrator', sample: { ok: true, data: { verified: true } } });
add('01 Authentication', 'POST', '/api/v1/auth/change-password', 'Change login password — revoke existing credentials', 'Required: currentPassword, newPassword (12–256 characters). Changes the password, increments tokenVersion and revokes all refresh tokens atomically. Log in again afterward.', { body: { currentPassword: '{{password}}', newPassword: '{{newPassword}}' }, role: 'Any active authenticated administrator', sample: { ok: true, data: { changed: true, loginRequired: true } } });

for (const [route, title, detail] of [
    ['/dashboard', 'Dashboard — machine status and active sessions', 'Returns environment and machines with remainingSeconds, online connection, isInSession and runningGames.'],
    ['/setup', 'Setup — all store configuration', 'Returns configuration, machines, games, game settings and machineSettings. Configuration stateVersion is 0 before its first write. Password hashes are excluded.'],
    ['/environment', 'Read environment settings', 'Returns store configuration, including environment and stateVersion.'],
    ['/usage-fees', 'Read usage fees', 'Returns store configuration, including usageFees.pointsPerMinute and stateVersion.'],
    ['/jackpot-settings', 'Read total jackpot allocations', 'Returns store configuration, including totalJackpot and shared stateVersion.']
]) add('02 Store Setup', 'GET', store + route, title, detail, { role: viewer, capture: ['configVersion', route === '/setup' ? 'configuration.stateVersion' : 'stateVersion'], sample: { ok: true, data: route === '/dashboard' ? { environment: {}, machines: [] } : route === '/setup' ? { configuration: { stateVersion: 0 }, machines: [], games: [], settings: [], machineSettings: [] } : { storeId: '{{storeId}}', stateVersion: 0, environment: {}, usageFees: {} } } });
add('02 Store Setup', 'PUT', store + '/environment', 'Update environment settings', 'Required: expectedVersion, environment, reason. Partial environment updates merge. Accepted keys: operatingPcs (0–10000), serverIp (IPv4/IPv6), storeName (1–128), timezone (up to 100 characters). All configuration writes share configVersion.', { role: owner, body: change('configVersion', { environment: { operatingPcs: 10, serverIp: '127.0.0.1', storeName: 'My Store', timezone: 'Asia/Kolkata' } }), capture: ['configVersion', 'stateVersion'] });
add('02 Store Setup', 'PUT', store + '/usage-fees', 'Update server usage fees', 'Required: expectedVersion, positive integer pointsPerMinute, reason. Paid activation uses a positive machine feePlan override, otherwise this store rate. Missing rates reject paid time.', { role: owner, body: change('configVersion', { pointsPerMinute: 10 }), capture: ['configVersion', 'stateVersion'] });
const allocations = { smallJackpot: { percentageBps: 9500 }, mediumJackpot: { percentageBps: 450 }, bigJackpot: { percentageBps: 50 } };
add('02 Store Setup', 'PUT', store + '/jackpot-settings', 'Update total jackpot allocations', 'Required: expectedVersion, allocations, reason. Each share is integer basis points (0–10000); the three shares must total 10000. Updates registered games and PC overrides atomically while preserving their other settings. Blocked by recoverable sessions.', { role: owner, body: change('configVersion', { allocations }), capture: ['configVersion', 'stateVersion'] });
add('02 Store Setup', 'POST', store + '/jackpot-settings/reset', 'Reset total jackpot allocations', 'Required: expectedVersion, reason. Resets total allocation shares to 9500/450/50 and propagates to games and machine overrides. Blocked by recoverable sessions.', { role: owner, body: change('configVersion'), capture: ['configVersion', 'stateVersion'] });
add('02 Store Setup', 'PUT', store + '/passwords', 'Set setup / lock / member / store password', 'Required: expectedVersion, kind, newPassword (12–256), reason. kind: setup, lock, member, store. Stores a password hash; configVersion changes.', { role: owner, body: change('configVersion', { kind: '{{passwordKind}}', newPassword: '{{newStorePassword}}' }), capture: ['configVersion', 'stateVersion'] });
add('02 Store Setup', 'POST', store + '/passwords/verify', 'Verify special store password', 'Required: kind and password. Verifies a previously configured special password. This does not grant additional role permissions.', { role: operator, body: { kind: '{{passwordKind}}', password: '{{storePassword}}' }, sample: { ok: true, eventId: '{{_requestEventId}}', data: { verified: true, kind: '{{passwordKind}}' }, error: null } });

for (const [route, title, role, detail] of [
    ['/games', 'List registered games', viewer, 'Returns registered games.'],
    ['/games/:gameId/settings', 'Read game settings versions', viewer, 'Returns an array of settings versions, newest first. The first record supplies settingsVersion. Not a single settings object.'],
    ['/games/:gameId/pools', 'Read game pool balances', reader, 'Returns canonical/shared pools for the selected game.'],
    ['/games/:gameId/sessions', 'Read game sessions', viewer, 'Returns sessions. STORE_STAFF receives only game/machine/session/status fields. Gameplay start/deposit/exit are Socket.IO operations.']
]) add('03 Games and Jackpots', 'GET', store + route, title, detail, { role, query: query(filters), sample: { ok: true, data: [] }, capture: route.endsWith('/settings') ? ['settingsVersion', '0.version'] : undefined });
add('03 Games and Jackpots', 'POST', store + '/games', 'Register game and initial settings', 'Required: gameId, name (1–128), reason. Creates an active game and initial settings; new games inherit total jackpot allocations.', { role: owner, body: { gameId: '{{gameId}}', name: 'Seven Slot', reason: '{{reason}}' } });
add('03 Games and Jackpots', 'PUT', store + '/games/:gameId/settings', 'Update full game settings', 'Required: expectedVersion, full settings object, reason. Uses the game ID in the URL. Jackpot shares total 10000; basis points are 10000 = 100%. network.threshold must be positive. Blocked by recoverable sessions for the game.', { role: owner, body: change('settingsVersion', { settings: settings() }), capture: ['settingsVersion', 'version'] });
add('03 Games and Jackpots', 'POST', store + '/games/:gameId/settings/reset', 'Reset game settings to defaults', 'Required: expectedVersion, reason. Creates a new default settings version using current store total allocations. Blocked by recoverable sessions.', { role: owner, body: change('settingsVersion'), capture: ['settingsVersion', 'version'] });
add('03 Games and Jackpots', 'POST', store + '/games/:gameId/jackpots', 'Reserve jackpot from a canonical pool', 'Required: sessionId, poolType (SJ/MJ/BJ), positive amount, reason. Requires an active target session, sufficient canonical pool balance and no pending non-normal award. Optional allFruit:{variant}. This route is not the shared/local dual-jackpot offer flow.', { role: owner, body: { sessionId: '{{sessionId}}', poolType: 'SJ', amount: 50000, reason: '{{reason}}' } });

add('04 Machines', 'GET', store + '/machines', 'List machines and usage time', 'Returns machine records. Captures machineVersion from the record matching machineId. Use Dashboard for calculated remaining time and online status.', { role: viewer, query: query(filters), sample: { ok: true, data: [] }, captureMachineList: true });
add('04 Machines', 'POST', store + '/machines', 'Register machine — initially idle', 'Required: machineId, positive machineNumber, reason. Optional feePlan (integer points per minute; 0 inherits store rate), ipAddress, supplyDate. New machines have zero time and stateVersion 1.', { role: owner, body: machine(), capture: ['machineVersion', 'stateVersion'] });
const machineChanges = change('machineVersion', { machineNumber: 1, feePlan: 10, ipAddress: '127.0.0.1', supplyDate: '2026-10-14T00:00:00.000Z' });
add('04 Machines', 'PATCH', store + '/machines/:machineId', 'Modify machine registration and fee plan', 'Required: expectedVersion, reason and at least one changed field. Optional machineNumber, positive feePlan, ipAddress, supplyDate, operationalStatus (IN_USE/STOPPED/UNUSED).', { role: owner, body: machineChanges, capture: ['machineVersion', 'stateVersion'] });
add('04 Machines', 'PUT', store + '/machines/:machineId/status', 'Change PC operational status', 'Required: expectedVersion, reason and changed fields. STOPPED pauses active time; IN_USE requires assigned card and remaining time; UNUSED requires cleared time and settled sessions. Status changes are versioned and audited.', { role: owner, body: change('machineVersion', { operationalStatus: 'STOPPED' }), capture: ['machineVersion', 'stateVersion'] });
add('04 Machines', 'POST', store + '/machines/:machineId/reset', 'Reset machine and clear card assignment', 'Required: expectedVersion, reason. Requires zero remaining time and no recoverable session. Clears assignment/time, records machine_reset and sends a time snapshot.', { role: owner, body: change('machineVersion'), capture: ['machineVersion', 'stateVersion'] });
add('04 Machines', 'DELETE', store + '/machines/:machineId', 'Deactivate machine and revoke bound devices', 'Required: expectedVersion, reason in JSON body. Requires zero time and settled sessions. Marks DELETED and revokes bound game/agent devices; records are retained.', { role: owner, body: change('machineVersion'), capture: ['machineVersion', 'stateVersion'] });
add('04 Machines', 'GET', store + '/machines/:machineId/history', 'Read machine financial history', 'Returns ledger entries for the machine; readers role set excludes STORE_STAFF. Use Histories for operator-friendly categorized views.', { role: reader, query: query(filters), sample: { ok: true, data: [] } });
add('04 Machines', 'GET', store + '/machines/:machineId/commands', 'Read machine command lifecycle', 'Returns requested/acknowledged/succeeded/failed/timed-out command records. Acknowledgement and results come from the TAS-C socket client.', { role: viewer, query: query(filters), sample: { ok: true, data: [] } });
add('04 Machines', 'POST', store + '/machines/:machineId/commands', 'Request PC operating-system command', 'Required: type (shutdown/reboot/agent-stop/screen-lock/screen-unlock), reason. Queues an agent-only command expiring after 30 seconds. Requires enrolled agent integration to perform the action.', { role: operator, body: { type: 'screen-lock', reason: '{{reason}}' } });

add('05 Machine Time', 'POST', store + '/machines/:machineId/time/start', 'Start paid usage and assign card', 'Required: expectedVersion, minutes (1–500), reason; supply cardId to assign a card. Server computes points cost from fees. Optional amount must exactly match that cost. Cannot replace a card with remaining time or another card’s recoverable session.', { role: operator, body: change('machineVersion', { cardId: '{{cardId}}', minutes: 30 }), capture: ['machineVersion', 'stateVersion'] });
add('05 Machine Time', 'POST', store + '/machines/:machineId/time/start', 'Start usage using prepaid card minutes', 'Same start route, with useCardTime:true. Consumes card timeMinutes rather than points. amount must be absent or zero. Requires sufficient prepaid time and current machine version.', { role: operator, body: change('machineVersion', { cardId: '{{cardId}}', minutes: 10, useCardTime: true }), capture: ['machineVersion', 'stateVersion'] });
for (const [action, title, text, minutes] of [
    ['paid', 'Add paid usage time', 'Deducts card points using authoritative fees, or prepaid minutes with useCardTime:true. Maximum 500 minutes.', 30],
    ['service', 'Add service usage time', 'Administrator time grant without point debit. Maximum 500 minutes. Assigned active card is required.', 15],
    ['maintenance', 'Add maintenance usage time', 'Administrator maintenance grant without point debit. Maximum 10 minutes. Assigned active card is required.', 5]
]) add('05 Machine Time', 'POST', store + `/machines/:machineId/time/${action}`, title, `Required: expectedVersion, minutes, reason; optional cardId. ${text}`, { role: operator, body: change('machineVersion', { cardId: '{{cardId}}', minutes }), capture: ['machineVersion', 'stateVersion'] });
for (const [action, title, text] of [
    ['pause', 'Pause active machine time', 'Requires ACTIVE time with a positive balance; freezes remaining seconds.'],
    ['resume', 'Resume paused machine time', 'Requires PAUSED time with a positive balance; creates a new deadline.'],
    ['delete', 'Delete remaining machine time', 'Zeros remaining time, marks IDLE, interrupts active game sessions recoverably and queues force-exit. Does not settle game funds or refund points.']
]) add('05 Machine Time', 'POST', store + `/machines/:machineId/time/${action}`, title, `Required: expectedVersion and reason. ${text}`, { role: operator, body: change('machineVersion'), capture: ['machineVersion', 'stateVersion'] });

add('06 PC Settings', 'GET', store + '/machines/:machineId/games/:gameId/settings', 'Read per-PC game settings override', 'Returns override records for this machine/game. Empty array means no override; use machineSettingsVersion 0 for first creation. This version is independent of game settingsVersion.', { role: viewer, sample: { ok: true, data: [] }, capture: ['machineSettingsVersion', '0.version'] });
add('06 PC Settings', 'PUT', store + '/machines/:machineId/games/:gameId/settings', 'Update PC-specific RTP and game settings', 'Required: expectedVersion, full settings, reason. Stores a PC override; blocked by any recoverable session on the PC. Game reads and newly started sessions resolve the override.', { role: owner, body: change('machineSettingsVersion', { settings: settings() }), capture: ['machineSettingsVersion', 'version'] });
add('06 PC Settings', 'POST', store + '/machines/:machineId/games/:gameId/settings/reset', 'Reset PC settings to current game defaults', 'Required: expectedVersion, reason. Copies current game settings into a new PC override version. Blocked by recoverable sessions on the machine.', { role: owner, body: change('machineSettingsVersion'), capture: ['machineSettingsVersion', 'version'] });

add('07 Cards', 'GET', store + '/cards', 'List registered cards', 'Returns current card records. STORE_STAFF sees only cardId/displayNumber/status. Captures cardVersion for the selected card when available.', { role: viewer, query: query(filters), sample: { ok: true, data: [] }, captureCardList: true });
add('07 Cards', 'POST', store + '/cards', 'Register player card with hex UID', 'Required: cardId, hexadecimal cardUid, displayNumber (up to 32). Optional name, points, timeMinutes (0–1000000), date, kind (PLAYER/ADMIN). UID is normalized without 0x; duplicates are rejected. Initial values or ADMIN kind require owner authority.', { role: operator + ' (initial value / ADMIN requires owner)', body: { cardId: '{{cardId}}', cardUid: '{{cardUid}}', displayNumber: '0001', name: 'Player Card', points: 0, timeMinutes: 0, kind: 'PLAYER', date: '2026-10-14T00:00:00.000Z' }, capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'POST', store + '/cards/validate', 'Tap card — resolve hexadecimal UID', 'Required: exactly one of cardUid or cardId. Optional machineNumber and kioskFlag. Returns active card identity/balance and records successful/failed validations. This example uses hexadecimal UID.', { role: operator, body: { cardUid: '{{cardUid}}' }, capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'POST', store + '/cards/validate', 'Validate card by registered ID', 'Same validation route using cardId instead of cardUid; never supply both identities.', { role: operator, body: { cardId: '{{cardId}}' }, capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'PATCH', store + '/cards/:cardId', 'Update card points / prepaid time / metadata', 'Required: expectedVersion, reason and at least one of points, timeMinutes, displayNumber or name. points/timeMinutes are absolute balances. Requires no recoverable session or remaining assigned machine time. Financial changes are recorded.', { role: owner, body: change('cardVersion', { points: 1000, timeMinutes: 60, displayNumber: '0001', name: 'Player Card' }), capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'POST', store + '/cards/:cardId/adjustments', 'Adjust card points by signed amount', 'Required: nonzero signed integer amount and reason. Positive adds points; negative deducts. Result must remain nonnegative and within the supported money bound. Does not use expectedVersion.', { role: owner, body: { amount: 1000, reason: '{{reason}}' }, capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'POST', store + '/cards/:cardId/reset', 'Reset card points and prepaid time', 'Required: expectedVersion, reason only. Zeros points and prepaid minutes. Requires settled recoverable sessions and zero remaining assigned machine time.', { role: owner, body: change('cardVersion'), capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'DELETE', store + '/cards/:cardId', 'Deactivate a zero-value card', 'Required: expectedVersion and reason in JSON body. Requires zero points/timeMinutes, no recoverable session and no remaining assigned time. Marks DELETED; preserves financial records.', { role: owner, body: change('cardVersion'), capture: ['cardVersion', 'stateVersion'] });
add('07 Cards', 'DELETE', store + '/admin-cards/:cardId', 'Remove registered admin card', 'Required: expectedVersion and reason. Card must have kind ADMIN and satisfy the same zero-value/in-use restrictions as card deletion. Set adminCardId/adminCardVersion separately from the player card.', { role: owner, actual: store + '/admin-cards/{{adminCardId}}', body: change('adminCardVersion'), capture: ['adminCardVersion', 'stateVersion'] });
add('07 Cards', 'GET', store + '/cards/:cardId/ledger', 'Read complete card financial ledger', 'Returns card financial movements. Readers role set excludes STORE_STAFF; categorized Histories also supports operators.', { role: reader, query: query(filters), sample: { ok: true, data: [] } });

add('08 Devices and Users', 'POST', store + '/devices', 'Enroll Unity game device', 'Required: deviceId, role:GAME_CLIENT, machineId, gameId, installationId, secret (24–256), reason. Machine/game must be registered and installation must be unique.', { role: owner, body: gameDevice() });
add('08 Devices and Users', 'POST', store + '/devices', 'Enroll TAS-C machine agent', 'Required: deviceId, role:DEVICE_TAS_C, machineId, secret (24–256), reason. Do not supply gameId, installationId or kioskId. One TAS-C enrollment per machine.', { role: owner, body: { deviceId: '{{agentDeviceId}}', role: 'DEVICE_TAS_C', machineId: '{{machineId}}', secret: '{{deviceSecret}}', reason: '{{reason}}' } });
add('08 Devices and Users', 'POST', store + '/devices', 'Enroll TAS-K kiosk device', 'Required: deviceId, role:DEVICE_TAS_K, kioskId, secret (24–256), reason. No machine/game/installation scope is allowed.', { role: owner, body: { deviceId: '{{kioskDeviceId}}', role: 'DEVICE_TAS_K', kioskId: '{{kioskId}}', secret: '{{deviceSecret}}', reason: '{{reason}}' } });
add('08 Devices and Users', 'POST', store + '/devices/revoke', 'Revoke device credential', 'Required: deviceId, reason. Marks device REVOKED. Future connections and authorized socket events reject the credential.', { role: owner, body: { deviceId: '{{deviceId}}', reason: '{{reason}}' } });
add('08 Devices and Users', 'POST', store + '/users', 'Create store administrator / staff / auditor', 'Required: username, password (12–256), role (STORE_OWNER/STORE_STAFF/READ_ONLY_AUDITOR), reason. Cannot create HQ_SUPER_ADMIN using this API. Choose a new unique username.', { role: owner, body: { username: 'staff_001', password: '{{newPassword}}', role: 'STORE_STAFF', reason: '{{reason}}' } });
add('08 Devices and Users', 'POST', store + '/users', 'Register Admin User', 'Registers a new store administrator with role STORE_OWNER. First log in as an existing STORE_OWNER or HQ_SUPER_ADMIN; this request inherits the collection Bearer accessToken. Set newAdminUsername and newAdminPassword before sending. Required: unique username (1–128 letters, digits, underscores or hyphens), password (12–256 characters), role:STORE_OWNER and reason (3–500 characters), plus eventId. The server assigns the URL storeId, generates userId/dataId, hashes the password with Argon2id and saves status ACTIVE / tokenVersion 1. The response excludes the password hash and does not log in the newly created user. To log in as the new admin, use the login endpoint with the new credentials. This is not a public signup or first-admin bootstrap endpoint, and it cannot create HQ_SUPER_ADMIN accounts.', {
    role: owner,
    body: { username: '{{newAdminUsername}}', password: '{{newAdminPassword}}', role: 'STORE_OWNER', reason: 'Register store administrator' },
    capture: ['adminUserId', 'userId'],
    sample: { ok: true, eventId: '{{_requestEventId}}', serverSequence: 1, serverTime: '2026-10-14T00:00:00.000Z', stateVersion: null,
        data: { storeId: '{{storeId}}', username: '{{newAdminUsername}}', role: 'STORE_OWNER', userId: '<server-generated-user-id>', dataId: '<server-generated-data-id>', status: 'ACTIVE', tokenVersion: 1, reason: 'Register store administrator' }, error: null }
});
add('08 Devices and Users', 'POST', store + '/kiosks/:kioskId/reset', 'Reset kiosk UI / counters', 'Required: reason. Requires active enrolled kiosk. Records kiosk_reset and queues a kiosk.reset.v1 notification. Financial records and card balances remain intact; hardware/UI handling is client-side.', { role: owner, body: { reason: '{{reason}}' } });

const historyMeaning = {
    'tasc-usage': 'PC paid usage, time changes and prepaid time consumption', 'card-usage': 'Card spending, game deposits/exits and prepaid usage',
    'task-usage': 'Kiosk topup usage', 'kiosk-transactions': 'Kiosk topup transactions including bill and cash metadata',
    'tasc-reset': 'Machine reset/deactivation ledger records', 'card-reset': 'Card points-reset records', 'task-reset': 'Kiosk reset records',
    'card-registration': 'Card registrations and initial point value', 'tasc-details': 'Machine-related audit details',
    'card-transactions': 'Full ledger movement history; set cardId to select one card', 'pc-status': 'PC status and time-change records',
    'pc-payout': 'Normal, jackpot and legacy payout records', 'pc-accumulate': 'Bet and shared/network contribution records',
    'pc-receive': 'Incoming business-event audit records', 'history-reset': 'Store history archive/reset records', 'activity': 'Administrator/device activity audit'
};
for (const category of Object.keys(historyCategories)) add('09 Histories and Audit', 'GET', store + '/histories/:category', `History — ${category}`, `${historyMeaning[category]}. Output: {category,historyResetAt,nextCursor,records}. Optional machineId/cardId/kioskId/gameId/actorId/action/from/to/before filters. Pass nextCursor as cursor with identical filters to preserve tied timestamps. includeArchived=true includes records before the archive boundary.`, { role: viewer, actual: store + `/histories/${category}`, query: [...query(['limit', 'machineId', 'cardId', 'kioskId', 'gameId', 'action', 'from', 'to', 'before']), { key: 'cursor', value: '{{historyCursor}}', disabled: true, description: 'Opaque nextCursor from this history and the same filters.' }, { key: 'includeArchived', value: 'true', disabled: true, description: 'Include records before historyResetAt.' }], sample: { ok: true, data: { category, nextCursor: null, records: [] } }, capture: ['historyCursor', 'nextCursor'] });
add('09 Histories and Audit', 'GET', store + '/audit', 'Read raw store audit records', 'Returns audit records, including authentication and successful/failed tap events. Optional action/date/identity filters. Reader-only role set; Histories activity supports operators.', { role: reader, query: query(filters), sample: { ok: true, data: [] } });
add('09 Histories and Audit', 'POST', store + '/activities', 'Record TAS-S application activity', 'Required: category and success. category: card-tapped/logged-in/status/validation/transaction/admin-activity. Optional cardId, message, transactionMethod (CASH/CARD/OTHER), validationSuccessCount, cashInjectionData:{denomination,count}, cardName. Server supplies actor scope.', { role: operator, body: { category: 'admin-activity', success: true, cardId: '{{cardId}}', message: 'Operator opened card screen' } });
add('09 Histories and Audit', 'POST', store + '/histories/reset', 'Archive current histories', 'Required: expectedVersion, reason. Advances configuration historyResetAt and records history_reset. Older ledger/audit evidence is retained and available with includeArchived=true. Does not reset balances.', { role: owner, body: change('configVersion'), capture: ['configVersion', 'stateVersion'] });

add('10 Settlements', 'GET', store + '/settlements/current', 'Read open settlement period', 'Returns an array containing the open period and its financial totals.', { role: reader, query: query(['limit', 'before']), sample: { ok: true, data: [] } });
add('10 Settlements', 'GET', store + '/settlements/history', 'Read closed settlement history', 'Returns CLOSED periods with totals/checksum/closure metadata. Use before for older records.', { role: reader, query: query(['limit', 'before', 'from', 'to']), sample: { ok: true, data: [] } });
add('10 Settlements', 'POST', store + '/settlements/close', 'Close settlement and open a new period', 'Required: reason. Creates a closed immutable totals snapshot/checksum, opens a new period and queues settlement.closed for HQ reporting. Does not clear game/card balances.', { role: owner, body: { reason: '{{reason}}' } });

add('11 HQ Fleet Administration', 'POST', '/api/v1/auth/login', 'Log in — HQ super administrator', 'Uses the same login endpoint with the HQ home store, username and password. Account must have HQ_SUPER_ADMIN, provisioned locally by the HQ bootstrap script. Captures hqAccessToken/hqRefreshToken separately.', { public: true, body: { storeId: '{{hqHomeStoreId}}', username: '{{hqUsername}}', password: '{{hqPassword}}' }, captureTokens: 'hq' });
const hqQuery = [{ key: 'limit', value: '100', description: '1–500; default 100.' }, { key: 'storeId', value: '{{hqStoreId}}', disabled: true, description: 'Optional; omit to include every store in this backend database.' }, { key: 'cursor', value: '{{hqCursor}}', disabled: true, description: 'Opaque nextCursor from the same HQ endpoint and filter.' }];
add('11 HQ Fleet Administration', 'GET', '/api/v1/hq/machines', 'HQ — list fleet with agent status', 'Returns local-database fleet records with supply/IP/time and enrolled agent version/access/online status. Returns top-level nextCursor. Does not discover other remote store databases.', { hq: true, role: 'HQ_SUPER_ADMIN only', query: hqQuery, sample: { ok: true, nextCursor: null, data: [] }, captureTopCursor: true });
add('11 HQ Fleet Administration', 'GET', '/api/v1/hq/activity', 'HQ — read cross-store activity', 'Returns audit records across locally managed stores or the selected store filter. Pass top-level nextCursor as cursor for the next page.', { hq: true, role: 'HQ_SUPER_ADMIN only', query: hqQuery, sample: { ok: true, nextCursor: null, data: [] }, captureTopCursor: true });
add('11 HQ Fleet Administration', 'POST', '/api/v1/hq/stores/:storeId/machines', 'HQ — register machine in target store', 'Same machine creation payload as store registration. Target store must already be active. Uses hqStoreId rather than the HQ home-store ID.', { hq: true, role: 'HQ_SUPER_ADMIN only', body: { ...machine(), machineId: '{{hqMachineId}}' }, capture: ['hqMachineVersion', 'stateVersion'] });
add('11 HQ Fleet Administration', 'PATCH', '/api/v1/hq/stores/:storeId/machines/:machineId', 'HQ — modify target machine', 'Required: expectedVersion, reason and changed fields. Uses the target machine version; permitted fields and lifecycle rules match the store endpoint.', { hq: true, role: 'HQ_SUPER_ADMIN only', body: change('hqMachineVersion', { ipAddress: '127.0.0.1', feePlan: 10 }), capture: ['hqMachineVersion', 'stateVersion'] });
add('11 HQ Fleet Administration', 'DELETE', '/api/v1/hq/stores/:storeId/machines/:machineId', 'HQ — deactivate target machine', 'Required: expectedVersion, reason. Requires no recoverable sessions and zero remaining time; marks DELETED and revokes bound devices.', { hq: true, role: 'HQ_SUPER_ADMIN only', body: change('hqMachineVersion'), capture: ['hqMachineVersion', 'stateVersion'] });
add('11 HQ Fleet Administration', 'POST', '/api/v1/hq/stores/:storeId/devices', 'HQ — enroll target TAS-C agent', 'Required: deviceId, role:DEVICE_TAS_C, machineId, secret (24–256), reason. Other supported device roles use the same role-dependent enrollment rules as the store route.', { hq: true, role: 'HQ_SUPER_ADMIN only', body: { deviceId: '{{agentDeviceId}}', role: 'DEVICE_TAS_C', machineId: '{{hqMachineId}}', secret: '{{deviceSecret}}', reason: '{{reason}}' } });

const businessDescription = '\n\n**Business write envelope:** a fresh eventId is injected automatically. Optional correlationId is accepted; idempotency-key is an alternative to eventId in the body. Identifiers are 1–128 characters using letters, digits, underscores or hyphens; reason must be 3–500 characters. Money/point values are integers bounded by 1000000000000. URL identifiers override body identities. For an identical retry, reuse the original eventId AND original body/version; response scripts update versions, so restore original values first. Set eventId manually to freeze it, otherwise leave it empty for new operations. Writes can change points, time, credentials or machine state; run individual requests deliberately.';
function materialize(def) {
    let route = def.actual || def.route;
    route = route.replace(/:([A-Za-z]+)/g, (_, key) => `{{${def.hq && key === 'storeId' ? 'hqStoreId' : def.hq && key === 'machineId' ? 'hqMachineId' : key}}}`);
    const q = def.query || [];
    const raw = '{{baseUrl}}' + route + (q.some(value => !value.disabled) ? '?' + q.filter(value => !value.disabled).map(value => `${value.key}=${value.value}`).join('&') : '');
    const request = { method: def.method, header: [{ key: 'Accept', value: 'application/json' }],
        url: { raw, host: ['{{baseUrl}}'], path: route.slice(1).split('/'), ...(q.length ? { query: q } : {}) },
        description: `${def.description}\n\n**Authorization:** ${def.public ? 'No Bearer token required.' : def.role || owner}${def.hq ? '\nUses hqAccessToken.' : ''}${def.body && !def.route.startsWith('/api/v1/auth/') ? businessDescription : ''}\n\n**Common errors:** 400 INVALID_PAYLOAD / invalid state; 401 AUTH_REQUIRED; 403 FORBIDDEN; 404 NOT_FOUND; 409 STALE_VERSION / CONFLICT. Business success returns HTTP 200, including create/delete. Rate limiting can return 429.` };
    if (def.public) request.auth = { type: 'noauth' };
    else if (def.hq) request.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{hqAccessToken}}', type: 'string' }] };
    if (def.body) {
        const business = !def.route.startsWith('/api/v1/auth/');
        const body = business ? { eventId: '{{_requestEventId}}', ...def.body } : def.body;
        request.header.push({ key: 'Content-Type', value: 'application/json' });
        request.body = { mode: 'raw', raw: JSON.stringify(body, null, 2).replace(/"\{\{([A-Za-z]+Version)\}\}"/g, '{{$1}}'), options: { raw: { language: 'json' } } };
        request.description += '\n\n### Request body example\n\nOpen **Body → raw → JSON**. Replace variables using collection values before sending. Numeric versions resolve to integers.\n\n```json\n' + request.body.raw + '\n```';
    } else {
        request.description += '\n\n### Request input example\n\nThis GET endpoint does not accept a JSON body. Use the URL identifiers and the **Params** tab.\n\n```text\n' + raw + '\n```';
        if (q.length) request.description += '\n\nOptional filters are listed in Params and disabled initially. Enable only the filters needed for your query.';
    }
    const scripts = ["let result; try { result = pm.response.json(); } catch (_) {}", 'if (pm.response.code >= 200 && pm.response.code < 300 && result && result.ok !== false) {'];
    if (def.captureTokens) {
        const prefix = def.captureTokens === 'hq' ? 'hq' : '';
        scripts.push(`  pm.collectionVariables.set('${prefix ? 'hqAccessToken' : 'accessToken'}', result.data.accessToken);`,
            `  pm.collectionVariables.set('${prefix ? 'hqRefreshToken' : 'refreshToken'}', result.data.refreshToken);`);
    }
    if (def.clearRefresh) scripts.push("  pm.collectionVariables.set('refreshToken', '');");
    if (def.capture) {
        const [variable, property] = def.capture;
        scripts.push(`  const value = ${JSON.stringify(property)}.split('.').reduce((node, key) => node == null ? undefined : node[key], result.data);`,
            `  if (value !== undefined) pm.collectionVariables.set('${variable}', value == null ? '' : String(value));`);
    }
    if (def.captureMachineList || def.captureCardList) {
        const kind = def.captureMachineList ? 'machine' : 'card';
        scripts.push(`  const item = Array.isArray(result.data) && result.data.find(row => row.${kind}Id === pm.variables.get('${kind}Id'));`,
            `  if (item && item.stateVersion !== undefined) pm.collectionVariables.set('${kind}Version', String(item.stateVersion));`);
    }
    if (def.captureTopCursor) scripts.push("  pm.collectionVariables.set('hqCursor', result.nextCursor || '');");
    scripts.push('}');
    const sample = def.sample || (def.route.startsWith('/api/v1/auth/') ? { ok: true, data: { accessToken: '<access-token>', refreshToken: '<refresh-token>', expiresIn: 3600 } } : { ok: true, eventId: '{{_requestEventId}}', serverSequence: 1, serverTime: '2026-10-14T00:00:00.000Z', stateVersion: null, data: {}, error: null });
    return { name: def.title, request, event: [{ listen: 'test', script: { type: 'text/javascript', exec: scripts } }], response: [
        { name: 'Illustrative success — response shape', originalRequest: structuredClone(request), status: 'OK', code: 200,
            header: [{ key: 'Content-Type', value: 'application/json' }], body: JSON.stringify(sample, null, 2) },
        { name: 'Illustrative validation error', originalRequest: structuredClone(request), status: 'Bad Request', code: 400,
            header: [{ key: 'Content-Type', value: 'application/json' }], body: JSON.stringify({ ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Payload validation failed' } }, null, 2) }
    ] };
}

// Inspect actual registered Express routes, including route loops, without connecting to a database.
const log = console.log;
let app;
try { console.log = () => {}; app = createHttp({ config: { origins: [] }, database: {}, auth: {}, backend: {} }); }
finally { console.log = log; }
const actual = [];
for (const layer of app.router.stack) {
    if (layer.route) for (const method of Object.keys(layer.route.methods)) actual.push(`${method.toUpperCase()} ${layer.route.path}`);
    else if (layer.name === 'router') {
        const prefix = layer.handle.stack.some(entry => entry.route?.path === '/dashboard') ? store : '/api/v1/hq';
        for (const entry of layer.handle.stack) if (entry.route) for (const method of Object.keys(entry.route.methods)) actual.push(`${method.toUpperCase()} ${prefix}${entry.route.path}`);
    }
}
const documented = new Set(definitions.map(def => `${def.method} ${def.route}`));
assert.deepEqual([...new Set(actual)].sort(), [...documented].sort(), 'Collection must cover every registered HTTP method/path, with no invented routes.');

const collection = {
    info: { _postman_id: randomUUID(), name: 'Slot Game Backend — Complete HTTP API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        description: `All ${documented.size} HTTP method/path contracts from src/transports/http.js, with titled requests, role and payload descriptions, response-shape examples and token/version capture. Generated 14 October 2026.\n\nImport this JSON, set collection variables baseUrl/storeId/username/password, then run Store administrator login. Collection Bearer authentication is inherited; health and login/refresh/logout are noauth. HQ requests use hqAccessToken. Keep secrets in private/local variable values.\n\nGET responses, registration responses and mutations capture the versions used by subsequent requests. Refresh versions after other clients change records. A machineSettings empty array means version 0; a config before creation is version 0.\n\nNew machines start idle and game sessions start at zero credit. Configure usage fees, register card/game/machine/device, assign paid time, then use the Socket.IO game operations described in SOCKET_API.md.\n\nDo not run every folder as an unattended setup script: reset/delete/password/command requests are real operations. Examples are illustrative shapes, not captured live-server responses. Numeric version placeholders are intentionally unquoted in raw JSON and resolve at send time. For retries, use original eventId and body/version.\n\nThe accompanying Local environment sets baseUrl only; credentials and identifiers are collection variables to keep token/version capture effective. Existing Postman workspace files are preserved.` },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    variable: Object.entries(variables).map(([key, value]) => ({ key, value, type: 'string', description: /password|secret|token/i.test(key) ? 'Private/local credential value; do not publish real secrets.' : /Version$/.test(key) ? 'Independent optimistic version; capture from the corresponding read or write response.' : key === 'eventId' ? 'Leave empty to generate a fresh event ID. Set only when replaying an identical original request.' : `Configurable ${key}.` })),
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [
        "const id = pm.variables.get('eventId') || pm.variables.replaceIn('{{$guid}}');",
        "pm.variables.set('_requestEventId', id);",
        "pm.collectionVariables.set('lastEventId', id);"
    ] } }],
    item: [...groups].map(([name, defs]) => ({ name, description: `Documented ${name.slice(3).toLowerCase()} operations. Each request describes its own permissions and required input.`, item: defs.map(materialize) }))
};

// Keep the exported collection identity stable so an updated import can replace the prior copy.
try {
    const previous = JSON.parse(await fs.readFile(path.join(directory, 'Slot_Game_Backend.postman_collection.json'), 'utf8'));
    if (previous.info?._postman_id) collection.info._postman_id = previous.info._postman_id;
} catch (error) { if (error.code !== 'ENOENT') throw error; }

for (const folder of collection.item) for (const item of folder.item) {
    assert.ok(item.name && item.request.description.length > 80);
    if (item.request.method !== 'GET') assert.ok(item.request.body?.raw && item.request.body.raw.trim() !== '{}', `Missing example body: ${item.name}`);
    for (const event of item.event) new vm.Script(event.script.exec.join('\n'));
    const raw = JSON.stringify(item.request);
    for (const [, key] of raw.matchAll(/\{\{([^}]+)\}\}/g)) assert.ok(key === '_requestEventId' || key in variables, `Undefined variable ${key}`);
    if (item.request.body) {
        const resolved = item.request.body.raw.replace(/\{\{([^}]+)\}\}/g, (_, key) => key === '_requestEventId' ? 'example-event-id' : variables[key]);
        JSON.parse(resolved);
    }
    for (const example of item.response) JSON.parse(example.body);
}
await fs.writeFile(path.join(directory, 'Slot_Game_Backend.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
await fs.writeFile(path.join(directory, 'Local.postman_environment.json'), JSON.stringify({ id: randomUUID(), name: 'Slot Game Backend — Local', values: [{ key: 'baseUrl', value: 'http://localhost:5000', enabled: true, type: 'default' }], _postman_variable_scope: 'environment' }, null, 2) + '\n');
const socketSource = await fs.readFile(path.join(directory, '../src/transports/socket.js'), 'utf8');
const httpSource = await fs.readFile(path.join(directory, '../src/transports/http.js'), 'utf8');
const canonicalBlock = socketSource.match(/const canonical = \[([\s\S]*?)\];/)[1];
const canonical = [...new Set([...adminlistEvents, ...[...canonicalBlock.matchAll(/'([^']+)'/g)].map(match => match[1])])];
const eventToHttp = new Map([...httpSource.matchAll(/setters\('([^']+)', '([^']+)', '([^']+)'\)/g)]
    .map(([, method, route, event]) => [event, definitions.find(def => def.method === method.toUpperCase() && def.route === store + route)]));
for (const action of ['paid', 'service', 'maintenance']) eventToHttp.set(`time.add.${action}.v1`, definitions.find(def => def.route.endsWith(`/time/${action}`)));
for (const action of ['pause', 'resume', 'delete']) eventToHttp.set(`time.${action}.v1`, definitions.find(def => def.route.endsWith(`/time/${action}`)));
const session = { sessionId: '{{sessionId}}', stateVersion: 1 };
const rules = { theme: 'SevenSlot', governmentBuild: false, minimumPools: [50000, 100000, 200000],
    smallAmounts: [50000], mediumAmounts: [100000], bigAmounts: [200000],
    smallLevelRanges: [50000, 50000, 50000, 50000, 50000, 50000],
    mediumLevelRanges: [100000, 100000, 100000, 100000, 100000, 100000],
    bigLevelRanges: [200000, 200000, 200000, 200000, 200000, 200000] };
const profiles = {
    'agent.activate.v1': ['Activate bound PC from points spent', '/agent; DEVICE_TAS_C', 'Derives whole paid minutes from the authoritative fee. Cannot select another PC.', { cardId: '{{cardId}}', pointsSpent: 100, expectedVersion: 1 }],
    'game.session.start.v1': ['Start or resume card game session', '/game; GAME_CLIENT', 'Requires active machine time and matching assigned active card. New sessions start at zero credit.', { cardId: '{{cardId}}' }],
    'game.session.snapshot.get.v1': ['Recover session and outstanding awards', '/game; GAME_CLIENT', 'Returns session, pendingAwards and expectedNextSequence for this enrolled installation.', {}],
    'game.state.update.v1': ['Submit canonical bet / normal-win receipt', '/game; GAME_CLIENT', 'Requires current stateVersion. Optional assignmentId completes the reserved normal award. This differs from Unity legacy balance snapshots.', { ...session, betAmount: 100 }],
    'game.state.restore.legacy.v1': ['Restore legacy Unity snapshot', '/game; GAME_CLIENT', 'Uses legacy deposit/bank fields, normalized to credit/bank. Optional remainingTime and jackpot presentation state are normalized by the transport. Applies session/version checks.', { ...session, deposit: 0, bank: 0, remainingTime: 60 }],
    'game.credit.deposit.v1': ['Deposit card points to game credit', '/game; GAME_CLIENT', 'Requires sufficient active card points and active machine/session. Debits card and increases session credit/deposit.', { ...session, amount: 1000 }],
    'game.session.exit.v1': ['Settle or interrupt game session', '/game; GAME_CLIENT', 'PLAYER_EXIT_BUTTON/PLAYER_X_KEY settle credit and net bank to card after checking awards. Other allowed reasons ADMIN_TIME_DELETE/TIME_EXPIRED/ADMIN_FORCE_EXIT/PROCESS_CRASH/MACHINE_SHUTDOWN/NETWORK_LOST retain recoverable state.', { ...session, exitReason: 'PLAYER_EXIT_BUTTON' }],
    'game.settings.get.v1': ['Read authoritative game/PC settings', '/game or /admin; game client/operators/auditor', 'Enrolled game identity supplies gameId for game clients; administrators supply gameId. Returns resolved PC override where applicable.', { gameId: '{{gameId}}' }],
    'game.settings.lock-status.v1': ['Read game setup lock status', '/game or /admin; game client/operators/auditor', 'Returns gameId, activeCount and editable based on active session count. Mutation lock checks additionally include recoverable sessions.', { gameId: '{{gameId}}' }],
    'game.pool.summary.get.v1': ['Read game jackpot pool summary', '/game or /admin; game client/readers', 'Returns pools scoped to the enrolled/requested game.', { gameId: '{{gameId}}' }],
    'game.jackpot.fund.v1': ['Fund shared and installation-local pools', '/game; GAME_CLIENT', 'Splits each gross pool contribution into 80% shared and remainder local. Requires active session/time; idempotent retries must preserve eventId.', { ...session, gross: { smallJackpot: 90, mediumJackpot: 4, bigJackpot: 1 } }],
    'game.jackpot.eligibility.v1': ['Report fresh jackpot eligibility and rules', '/game; GAME_CLIENT', 'Stores eligibility/rules and returns shared pool balances. Match sample rule values to the actual game build. Amount lists contain 1–1024 positive integers; minimumPools length 3; each level range has 6 values with positive lower bound no greater than upper bound.', { ...session, eligible: true, rules }],
    'game.jackpot.local.check.v1': ['Check and reserve installation-local jackpot', '/game; GAME_CLIENT', 'Checks local balances/rules and presentation conflicts. Underfunded contracts wait without reserving an active presentation slot.', { ...session, rules }],
    'game.jackpot.offer.respond.v1': ['Accept or decline shared jackpot offer', '/game; GAME_CLIENT', 'Only the installation receiving the unexpired shared offer may claim it. Playback begins after committed acceptance.', { ...session, awardId: '<offer-award-id>', accept: true }],
    'game.jackpot.check.v1': ['Check earlier Unity-local jackpot path', '/game; GAME_CLIENT', 'Separate older local authorization path. Send current balances plus build payout/range rules; do not mix with dual local/shared award completion.', { ...session, ...rules, smallJackpot: 50000, mediumJackpot: 0, bigJackpot: 0 }],
    'game.jackpot.progress.v1': ['Acknowledge / complete canonical jackpot', '/game; GAME_CLIENT', 'status is ACKNOWLEDGED or COMPLETED. Canonical completion credits bank. Do not also complete a Unity snapshot payout through this path or it can be counted twice.', { ...session, awardId: '<reserved-award-id>', status: 'ACKNOWLEDGED' }],
    'game.jackpot.test.v1': ['Simulate test jackpot', '/admin; owners only', 'Requires server ALLOW_TEST_JACKPOT=true outside production. Returns testOnly/simulated; not a real reservation.', { gameId: '{{gameId}}', amount: 50000 }],
    'kiosk.topup.requested.v1': ['Top up card from enrolled kiosk', '/kiosk; DEVICE_TAS_K', 'Requires positive amount, billId and reason. Bills deduplicate by kiosk/card/amount. Optional transactionMethod CASH/CARD/OTHER, validationSuccessCount, cashInjectionData and cardName are logged.', { cardId: '{{cardId}}', amount: 1000, billId: '<unique-bill-id>', reason: 'Cash topup', transactionMethod: 'CASH', validationSuccessCount: 1, cashInjectionData: { denomination: 1000, count: 1 }, cardName: 'Player Card' }],
    'time.snapshot.get.v1': ['Read authoritative machine time', '/agent, /game or /admin; devices/operators', 'Machine-bound devices use their enrolled machine; administrators supply machineId. Returns remainingSeconds and time state/version.', { machineId: '{{machineId}}' }],
    'command.ack.v1': ['Acknowledge queued operating-system command', '/agent; DEVICE_TAS_C', 'commandId must belong to this machine and be unexpired/requested or acknowledged.', { commandId: '<command-id>' }],
    'command.result.v1': ['Report operating-system command result', '/agent; DEVICE_TAS_C', 'Requires acknowledged command plus success boolean. Optional message up to 500 characters.', { commandId: '<command-id>', success: true, message: 'Command completed' }]
};
const socketLines = ['# Socket.IO API reference', '',
    'These are registered Socket.IO events, not HTTP routes. The HTTP Postman collection does not create artificial POST URLs for them. Use a compatible Socket.IO client with acknowledgement callbacks.', '',
    '## Connection and envelope', '',
    '- `/admin`: handshake auth `{token:"<administrator-access-token>"}`.',
    '- `/agent`: handshake auth `{storeId,deviceId,secret}` for enrolled DEVICE_TAS_C.',
    '- `/game`: same device credentials for GAME_CLIENT; authoritative game/machine/installation scope comes from enrollment.',
    '- `/kiosk`: same device credentials for DEVICE_TAS_K; kiosk scope comes from enrollment.',
    '', 'Business events use `{eventId:"<unique-id>",payload:{...}}`; optional sequence/correlationId and scoped IDs are checked. eventId supports identical retries. Handlers enforce roles regardless of which namespace registers the name. Use current session stateVersion where shown. Response callbacks use `{ok,eventId,serverSequence,serverTime,stateVersion,data,error}`; failures carry error codes. Raw heartbeat/replay formats are documented below.', '',
    'Rule-table values below are examples, not a replacement for the actual Unity build rules.', ''];
for (const event of canonical) {
    const mapped = eventToHttp.get(event);
    assert.ok(mapped || profiles[event], `Missing Socket.IO details for ${event}`);
    let [title, audience, description, payload] = profiles[event] || [mapped.title, `/admin; ${mapped.role}`, mapped.description, mapped.body];
    if (event === 'card.validate.v1') audience += '; also /agent DEVICE_TAS_C and /kiosk DEVICE_TAS_K';
    if (event === 'activity.record.v1') audience += '; also DEVICE_TAS_C / DEVICE_TAS_K';
    if (event === 'time.session.start.v1') audience += '; also /agent DEVICE_TAS_C, bound to its machineId';
    const normalizedPayload = structuredClone(payload || {});
    const route = mapped?.route || '';
    for (const field of ['gameId', 'machineId', 'cardId', 'kioskId']) if (route.includes(`:${field}`)) normalizedPayload[field] = `{{${field}}}`;
    socketLines.push(`## ${title}`, '', `**Event:** \`${event}\`  \n**Audience:** ${audience}`, '', description, '', 'Example envelope:', '', '```json', JSON.stringify({ eventId: '<unique-event-id>', payload: normalizedPayload }, null, 2), '```', '');
}
socketLines.push('## Device hello / heartbeat / version report', '',
    '`device.hello.v1`, `device.heartbeat.v1` and `agent.version.report.v1` accept raw `{version?:"1.2.3"}` without the business envelope. Update presence and enrolled-device version/access fields. Reply is `{ok,serverTime}` or `{ok:false,error}`.', '',
    '## Replay queued business events', '',
    '`sync.replay.v1` accepts a raw array `[{eventName:"<canonical event>",envelope:{eventId:"<original-id>",payload:{...}}}]`, at most 100. Replays sequentially and stops at the first failure. Only canonical event names above are accepted; retain original event IDs and bodies.', '',
    '## Legacy event aliases', '', '| Legacy name | Mapped canonical operation | Notes |', '|---|---|---|');
for (const [name, [event, response]] of Object.entries(legacyEvents)) socketLines.push(`| \`${name}\` | \`${event}\` | ${name === 'game_started' ? 'username/systemId/remainingTime trigger the legacy start adapter; assigned card and authenticated PC still apply.' : name === 'update_game' ? 'deposit/bank trigger Unity snapshot normalization; deposit maps to credit.' : 'Canonical payload and role checks apply.'}${response ? ` Also emits \`${response}\` response.` : ' Uses acknowledgement callback.'} |`);
socketLines.push('', '## Server notifications', '',
    'Examples include store.updated.v1, device.status.changed.v1, time.snapshot.v1, game.settings.updated.v1, game.session.started.v1, game.session.snapshot.v1, game.normal-win.assigned.v1, game.jackpot.awarded.v1, game.jackpot.offer.v1, game.jackpot.offer.cancelled.v1, game.command.force-exit.v1, game.state.resync-required.v1 and kiosk.reset.v1. Command notifications use command.<shutdown|reboot|agent-stop|screen-lock|screen-unlock>.requested.v1, with command.timeout.v1 for administrators. These are server emissions, not callable HTTP APIs. Delivery queues do not prove durable client receipt.', '',
    'Internal SYSTEM worker ticks are not registered client APIs and are intentionally excluded.', '');
await fs.writeFile(path.join(directory, 'SOCKET_API.md'), socketLines.join('\n'));
await fs.writeFile(path.join(directory, 'README.md'), `# Slot Game Backend Postman collection\n\nImport **Slot_Game_Backend.postman_collection.json** and optionally **Local.postman_environment.json**. The collection includes **${definitions.length} titled request examples covering all ${documented.size} registered HTTP method/path contracts**.\n\n1. Set collection variables baseUrl, storeId, username and password using your real locally provisioned credentials. No .env credentials have been copied.\n2. Send **Log in — store administrator**. Its response script captures accessToken/refreshToken. Health and public authentication requests skip Bearer authentication.\n3. Read the corresponding card/machine/config/settings record before a versioned change. Scripts capture versions automatically where the selected record is identifiable. PC settings creation uses version 0 when no override exists.\n4. Configure positive usage fees before starting paid time. Read each request description for role requirements, payload constraints and reset/delete effects.\n5. For HQ administration, set hqHomeStoreId/hqUsername/hqPassword, run HQ login, and select hqStoreId/hqMachineId for target operations. HQ scope covers stores in this backend database.\n\nThe environment supplies only baseUrl; keep token/version variables in collection scope. If environment/global variables duplicate collection variables, their scope precedence can override captured values. Keep actual secret values private/local.\n\nOptional query filters are disabled initially. Enable them deliberately. Histories and HQ requests capture cursor values; only enable the cursor query after selecting the same endpoint and filters. Ordinary list reads return arrays; game settings versions are newest first.\n\nEach business request gets a fresh eventId unless eventId is manually set. lastEventId records the generated ID. For retrying an accepted operation, restore its original ID **and original body/version**; automatic version capture must not change the replay payload.\n\nResponse examples show shapes only; they are not observed production results. Creating/deleting business records returns HTTP 200. Do not run all mutation requests as an unattended setup sequence. Socket-only gameplay, kiosk topups and device operations are described in **SOCKET_API.md**, not misrepresented as HTTP endpoints.\n\nRegenerate and validate route coverage, template variables, JSON bodies and script syntax with:\n\n\`\`\`powershell\nnode postman/generate-collection.mjs\n\`\`\`\n\nGenerated files stay under postman/. Existing .postman/resources.yaml and workspace globals are unchanged.\n`);
await fs.appendFile(path.join(directory, 'README.md'), '\nIf Body appears empty, see [BODY_EXAMPLES.md](BODY_EXAMPLES.md). All write requests have raw JSON body examples; GET inputs use URL identifiers and Params. Local YAML requests can be repaired with `node postman/repair-local-requests.mjs`.\n');
console.log(`Created ${definitions.length} request examples; verified complete coverage of ${documented.size} HTTP routes, variable references, example JSON and Postman script syntax.`);
