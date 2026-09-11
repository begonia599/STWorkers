import { HttpError, MAX_JSON_BYTES } from './http.js';

// Pinned ST 8172dcd constants, not a claim about current provider model availability.
const REASONING_MODELS = new Set([
    'o1', 'o3-mini', 'o3-mini-2025-01-31', 'o4-mini', 'o4-mini-2025-04-16', 'o3', 'o3-2025-04-16',
    'gpt-5', 'gpt-5-2025-08-07', 'gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5-nano', 'gpt-5-nano-2025-08-07',
    'gpt-5.1', 'gpt-5.1-2025-11-13', 'gpt-5.1-chat-latest', 'gpt-5.2', 'gpt-5.2-2025-12-11', 'gpt-5.2-chat-latest',
    'gpt-5.3-chat-latest', 'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17',
    'gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17', 'gpt-5.5', 'gpt-5.5-2026-04-23',
]);

export function applyReasoningOptions(payload, body) {
    if (body.reasoning_effort && REASONING_MODELS.has(body.model)) {
        payload.reasoning_effort = body.model === 'gpt-5.3-chat-latest' ? 'medium'
            : body.reasoning_effort === 'min' ? 'minimal' : body.reasoning_effort;
    }
    if (body.reasoning_effort && body.chat_completion_source === 'custom' && /^koboldcpp\/(.+)$/.test(body.model)) {
        payload.reasoning_effort = body.reasoning_effort;
    }
    if (body.verbosity && /^gpt-5/.test(body.model)) payload.verbosity = body.verbosity;
}

// ST's root-$defs transformation, with bounded expansion and own-property-safe lookup.
// This is deliberately not a general JSON Schema dereferencer and never fetches references.
export function flattenSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new HttpError(422, 'INVALID_JSON_SCHEMA', 'A JSON Schema object is required.');
    }
    const definitions = schema.$defs || {};
    let nodes = 0;
    let bytes = 0;
    const encoder = new TextEncoder();
    function count(text) {
        bytes += encoder.encode(text).byteLength;
        if (bytes > MAX_JSON_BYTES) throw new HttpError(413, 'SCHEMA_EXPANSION_LIMIT', 'Expanded JSON Schema exceeds 1 MiB.');
    }
    function resolve(value, parents = [], depth = 0, root = false) {
        if (++nodes > 20000 || depth > 64) throw new HttpError(422, 'SCHEMA_EXPANSION_LIMIT', 'JSON Schema expansion exceeds the node or depth limit.');
        if (!value || typeof value !== 'object') {
            count(JSON.stringify(value));
            return value;
        }
        if (!Array.isArray(value) && typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
            const name = value.$ref.split('/').at(-1);
            if (parents.includes(name) || !Object.hasOwn(definitions, name) || !definitions[name]) {
                count('{}');
                return {};
            }
            return resolve(definitions[name], [...parents, name], depth + 1);
        }
        count('[]');
        if (Array.isArray(value)) return value.map(item => { count(','); return resolve(item, parents, depth + 1); });
        const entries = [];
        for (const [key, child] of Object.entries(value)) {
            if (root && key === '$defs') continue;
            count(JSON.stringify(key) + ':,');
            entries.push([key, resolve(child, parents, depth + 1)]);
        }
        return Object.fromEntries(entries);
    }
    const result = resolve(schema, [], 0, true);
    delete result.$schema;
    return result;
}

export function schemaResponseFormat(option) {
    if (!option || typeof option !== 'object' || Array.isArray(option)
        || typeof option.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(option.name)
        || (option.strict != null && typeof option.strict !== 'boolean')) {
        throw new HttpError(422, 'INVALID_JSON_SCHEMA', 'A schema name (1-64 letters, digits, underscores or hyphens) and optional boolean strict flag are required.');
    }
    return {
        type: 'json_schema',
        json_schema: { name: option.name, strict: option.strict ?? true, schema: flattenSchema(option.value) },
    };
}
