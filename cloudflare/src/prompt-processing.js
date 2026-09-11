import { HttpError, MAX_JSON_BYTES, readJsonObject } from './http.js';

// Text-only port of ST 8172dcd's postProcessPrompt/mergeMessages (AGPL-3.0).
export const PROCESSING_TYPES = ['', 'claude', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single'];
const PLACEHOLDER = "Let's get started.";
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateMessages(messages, allowEmpty = false) {
    if (!Array.isArray(messages) || (!allowEmpty && !messages.length) || messages.length > 4096) {
        throw new HttpError(422, 'INVALID_MESSAGES', 'A chat messages array with at most 4096 entries is required.');
    }
    for (const message of messages) {
        if (!isObject(message) || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role)
            || !(typeof message.content === 'string' || message.content == null || (
                Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string')
            )) || (message.name != null && (typeof message.name !== 'string' || message.name.length > 512))) {
            throw new HttpError(422, 'INVALID_MESSAGES', 'This stage supports text chat messages and tool calls, not media or legacy text completions.');
        }
    }
}

export function boundedJson(value) {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The processed request exceeds 1 MiB.');
    }
    return serialized;
}

function promptNames(body) {
    const charName = String(body.char_name || '');
    const userName = String(body.user_name || '');
    const groupNames = Array.isArray(body.group_names) ? body.group_names.map(String) : [];
    if (charName.length > 512 || userName.length > 512 || groupNames.length > 128 || groupNames.some(name => name.length > 512)) {
        throw new HttpError(422, 'INVALID_PROMPT_NAMES', 'Prompt names are limited to 512 characters and 128 group names.');
    }
    return { charName, userName, startsWithGroupName: message => groupNames.some(name => message.startsWith(`${name}: `)) };
}

function mergeMessages(messages, names, { strict = false, placeholders = false, single = false, tools = false } = {}) {
    const mergedMessages = [];
    for (const message of messages) {
        if (!message.content) message.content = '';
        if (Array.isArray(message.content)) message.content = message.content.map(part => part.text).join('\n\n');
        if (message.role === 'system' && message.name === 'example_assistant') {
            if (names.charName && !message.content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(message.content)) {
                message.content = `${names.charName}: ${message.content}`;
            }
        }
        if (message.role === 'system' && message.name === 'example_user') {
            if (names.userName && !message.content.startsWith(`${names.userName}: `)) message.content = `${names.userName}: ${message.content}`;
        }
        if (message.name && message.role !== 'system' && !message.content.startsWith(`${message.name}: `)) {
            message.content = `${message.name}: ${message.content}`;
        }
        if (message.role === 'tool' && !tools) message.role = 'user';
        if (single) {
            if (message.role === 'assistant' && names.charName && !message.content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(message.content)) {
                message.content = `${names.charName}: ${message.content}`;
            }
            if (message.role === 'user' && names.userName && !message.content.startsWith(`${names.userName}: `)) {
                message.content = `${names.userName}: ${message.content}`;
            }
            message.role = 'user';
        }
        delete message.name;
        if (!tools) {
            delete message.tool_calls;
            delete message.tool_call_id;
        }
    }
    for (const message of messages) {
        const previous = mergedMessages.at(-1);
        if (previous?.role === message.role && message.content && message.role !== 'tool') {
            previous.content += '\n\n' + message.content;
        } else mergedMessages.push(message);
    }
    if (!mergedMessages.length) mergedMessages.push({ role: 'user', content: PLACEHOLDER });
    if (strict) {
        for (let i = 1; i < mergedMessages.length; i++) {
            if (mergedMessages[i].role === 'system') mergedMessages[i].role = 'user';
        }
        if (placeholders) {
            if (mergedMessages[0].role === 'system' && (mergedMessages.length === 1 || mergedMessages[1].role !== 'user')) {
                mergedMessages.splice(1, 0, { role: 'user', content: PLACEHOLDER });
            } else if (!['system', 'user'].includes(mergedMessages[0].role)) {
                mergedMessages.unshift({ role: 'user', content: PLACEHOLDER });
            }
        }
        return mergeMessages(mergedMessages, names, { placeholders, tools });
    }
    return mergedMessages;
}

export function postProcessPrompt(messages, type = '', body = {}) {
    if (!PROCESSING_TYPES.includes(type)) throw new HttpError(400, 'INVALID_PROCESSING_TYPE', 'Unknown prompt processing type.');
    validateMessages(messages, true);
    const copy = structuredClone(messages);
    if (type === '') return copy;
    const names = promptNames(body);
    const result = mergeMessages(copy, names, {
        strict: ['semi', 'semi_tools', 'strict', 'strict_tools', 'single'].includes(type),
        placeholders: ['strict', 'strict_tools'].includes(type),
        single: type === 'single',
        tools: type.endsWith('_tools'),
    });
    boundedJson(result);
    return result;
}

export async function handlePromptProcessing(request) {
    const body = await readJsonObject(request);
    if (!Array.isArray(body.messages)) throw new HttpError(400, 'INVALID_MESSAGES', 'Invalid messages format.');
    if (!PROCESSING_TYPES.includes(body.type)) throw new HttpError(400, 'INVALID_PROCESSING_TYPE', 'Unknown prompt processing type.');
    const result = { messages: postProcessPrompt(body.messages, body.type, body) };
    return new Response(boundedJson(result), { headers: { 'Content-Type': 'application/json' } });
}
