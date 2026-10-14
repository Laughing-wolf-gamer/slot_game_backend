import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const collection = JSON.parse(await fs.readFile(path.join(root, 'Slot_Game_Backend.postman_collection.json'), 'utf8'));
const examples = collection.item.flatMap(folder => folder.item);
const defaults = Object.fromEntries(collection.variable.map(variable => [variable.key, variable.value]));
const normalizeUrl = url => url.split('?')[0].replace(/\{\{[^}]+\}\}/g, ':');
const scalar = value => JSON.stringify(String(value));
const multiline = value => '|-\n' + value.split('\n').map(line => '  ' + line).join('\n');

function block(text, key) {
    const lines = text.split('\n');
    const start = lines.findIndex(line => line.startsWith(key + ':'));
    if (start === -1) return null;
    let end = start + 1;
    while (end < lines.length && !/^\S/.test(lines[end])) end++;
    return { start, end, lines: lines.slice(start, end), all: lines };
}
function setBlock(text, key, replacement) {
    const found = block(text, key);
    if (!found) return text.trimEnd() + '\n' + replacement + '\n';
    found.all.splice(found.start, found.end - found.start, replacement);
    return found.all.join('\n').trimEnd() + '\n';
}
function value(text, key) {
    const line = text.split('\n').find(line => line.startsWith(key + ':'));
    if (!line) return '';
    const raw = line.slice(key.length + 1).trim();
    if (raw.startsWith('"')) return JSON.parse(raw);
    if (raw.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    return raw;
}
function bodyRaw(text) {
    const section = block(text, 'body');
    if (!section) return '';
    const index = section.lines.findIndex(line => /^  content: \|/.test(line));
    return index < 0 ? '' : section.lines.slice(index + 1).map(line => line.replace(/^    /, '')).join('\n').trim();
}
function bodySection(raw) {
    return 'body:\n  type: json\n  content: |-\n' + raw.split('\n').map(line => '    ' + line).join('\n');
}
async function requests(directory) {
    const result = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== '.resources') result.push(...await requests(path.join(directory, entry.name)));
        else if (entry.isFile() && entry.name.endsWith('.request.yaml')) result.push(path.join(directory, entry.name));
    }
    return result;
}
let repairedBodies = 0;
let inspected = 0;
const roots = ['Slot Game Backend', 'Slot Game Backend — Complete HTTP API'];
for (const name of roots) {
    const directory = path.join(root, 'collections', name);
    try { await fs.access(directory); } catch { continue; }
    const admin = examples.find(example => example.name === 'Register Admin User');
    if (admin) {
        const folder = name === 'Slot Game Backend' ? 'Devices & Users' : '08 Devices and Users';
        const file = path.join(directory, folder, 'Register Admin User.request.yaml');
        try { await fs.access(file); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, '$kind: http-request\nname: Register Admin User\nmethod: POST\nurl: ' + scalar(admin.request.url.raw)
                + '\norder: 5500\nheaders:\n  Accept: application/json\n  Content-Type: application/json\n'
                + bodySection(admin.request.body.raw) + '\n');
        }
    }
    for (const file of await requests(directory)) {
        let text = (await fs.readFile(file, 'utf8')).replaceAll('\r\n', '\n');
        const original = text;
        const method = value(text, 'method');
        const url = value(text, 'url');
        const title = value(text, 'name');
        let sample = examples.find(example => example.name === title && example.request.method === method && normalizeUrl(example.request.url.raw) === normalizeUrl(url))
            || examples.find(example => example.request.method === method && normalizeUrl(example.request.url.raw) === normalizeUrl(url));
        if (!sample && normalizeUrl(url).endsWith('/histories/:')) sample = examples.find(example => example.name === 'History — card-usage');
        assert.ok(sample, `No documented API matches ${path.relative(root, file)}`);
        let raw = bodyRaw(text);
        if (method !== 'GET' && (!raw || raw === '{}')) {
            assert.ok(sample.request.body?.raw, `Missing source body: ${sample.name}`);
            raw = sample.request.body.raw;
            text = setBlock(text, 'body', bodySection(raw));
            if (!block(text, 'headers')) text += 'headers:\n  Content-Type: application/json\n  Accept: application/json\n';
            else if (!block(text, 'headers').lines.some(line => /Content-Type/i.test(line))) {
                const header = block(text, 'headers').lines.join('\n');
                text = setBlock(text, 'headers', header.trimEnd() + (header.includes('- key:') ? '\n  - key: Content-Type\n    value: application/json' : '\n  Content-Type: application/json'));
            }
            repairedBodies++;
        }
        if (url.includes('/api/v1/hq/')) {
            text = setBlock(text, 'url', 'url: ' + scalar(url.replaceAll('{{storeId}}', '{{hqStoreId}}').replaceAll('{{machineId}}', '{{hqMachineId}}')));
            if (!block(text, 'auth')) text += 'auth:\n  type: bearer\n  credentials:\n    token: "{{hqAccessToken}}"\n';
        }
        if (method === 'GET' && sample.request.url.query?.length && !block(text, 'queryParams')) {
            text += 'queryParams:\n' + sample.request.url.query.map(param => '  - key: ' + scalar(param.key) + '\n    value: ' + scalar(param.value)
                + (param.disabled ? '\n    disabled: true' : '') + '\n    description: ' + scalar(param.description || 'Optional query parameter.')).join('\n') + '\n';
        }
        let description = sample.request.description;
        if (method !== 'GET' && raw !== sample.request.body.raw) {
            description = description.replace(sample.request.body.raw, raw);
        }
        text = setBlock(text, 'description', 'description: ' + multiline(description));
        if (!block(text, 'scripts') && sample.event?.length) {
            text += 'scripts:\n' + sample.event.map(event => '  - type: afterResponse\n    code: |-\n'
                + event.script.exec.map(line => '      ' + line).join('\n') + '\n    language: text/javascript').join('\n') + '\n';
        }
        if (method !== 'GET') {
            const resolved = bodyRaw(text).replace(/\{\{([^}]+)\}\}/g, (_, key) => key === '_requestEventId' ? 'example-event-001' : defaults[key] ?? 'example');
            assert.notDeepEqual(JSON.parse(resolved), {}, `Empty native request body: ${file}`);
        }
        if (text !== original) await fs.writeFile(file, text);
        inspected++;
    }
    const metadataFile = path.join(directory, '.resources', 'definition.yaml');
    let metadata = (await fs.readFile(metadataFile, 'utf8')).replaceAll('\r\n', '\n');
    const section = block(metadata, 'variables');
    assert.ok(section, 'Expected collection variables metadata');
    const list = section.lines.some(line => /^  - key:/.test(line));
    const existingKeys = new Set(section.lines.flatMap(line => {
        const match = line.match(list ? /^  - key: ([^\s]+)$/ : /^  ([A-Za-z][A-Za-z0-9_]*):/);
        return match ? [match[1]] : [];
    }));
    const additions = collection.variable.filter(variable => !existingKeys.has(variable.key));
    const updatedVariables = section.lines.join('\n').trimEnd() + '\n' + additions.map(variable => list
        ? `  - key: ${variable.key}\n    value: ${scalar(variable.value)}` : `  ${variable.key}: ${scalar(variable.value)}`).join('\n');
    metadata = setBlock(metadata, 'variables', updatedVariables);
    metadata = metadata.replace(/(  - key: category\n    value:) wins\b/, '$1 card-usage');
    if (!block(metadata, 'scripts')) metadata += 'scripts:\n  - type: http:beforeRequest\n    code: |-\n'
        + collection.event[0].script.exec.map(line => '      ' + line).join('\n') + '\n    language: text/javascript\n';
    await fs.writeFile(metadataFile, metadata);
}
console.log(`Checked ${inspected} native requests; repaired ${repairedBodies} empty/missing write bodies. GET requests now explain URL/Params inputs. Existing nonempty bodies, variable values and scripts were preserved.`);
