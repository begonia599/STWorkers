import { Buffer } from 'node:buffer';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { crc32 } from 'crc';
import { HttpError } from './http.js';

// Adapted from the upstream ST PNG codec. The filesystem parser is deliberately not imported.
function encode(chunks) {
    const bytes = new Uint8Array(8 + chunks.reduce((size, chunk) => size + chunk.data.length + 12, 0));
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer);
    let offset = 8;
    for (const chunk of chunks) {
        const type = Uint8Array.from(chunk.name, character => character.charCodeAt(0));
        view.setUint32(offset, chunk.data.length);
        bytes.set(type, offset + 4);
        bytes.set(chunk.data, offset + 8);
        view.setUint32(offset + 8 + chunk.data.length, crc32(chunk.data, crc32(type)));
        offset += chunk.data.length + 12;
    }
    return bytes;
}

export function pngChunks(bytes) {
    try {
        return extract(new Uint8Array(bytes));
    } catch {
        throw new HttpError(400, 'INVALID_PNG', 'A valid PNG file is required.');
    }
}

export function readCardPng(bytes) {
    try {
        const chunks = pngChunks(bytes).filter(chunk => chunk.name === 'tEXt').map(chunk => PNGtext.decode(chunk.data));
        const metadata = chunks.find(chunk => chunk.keyword.toLowerCase() === 'ccv3')
            ?? chunks.find(chunk => chunk.keyword.toLowerCase() === 'chara');
        if (!metadata || metadata.text.length > 2 * 1024 * 1024) throw new Error('Missing or oversized metadata');
        return JSON.parse(Buffer.from(metadata.text, 'base64').toString('utf8'));
    } catch {
        throw new HttpError(400, 'INVALID_CARD', 'The PNG does not contain valid character metadata.');
    }
}

export function writeCardPng(bytes, card) {
    const chunks = pngChunks(bytes).filter(chunk => chunk.name !== 'tEXt'
        || !['chara', 'ccv3'].includes(new TextDecoder().decode(chunk.data).split('\0')[0].toLowerCase()));
    const v2 = { ...card, spec: 'chara_card_v2', spec_version: '2.0' };
    const v3 = { ...card, spec: 'chara_card_v3', spec_version: '3.0' };
    chunks.splice(-1, 0,
        PNGtext.encode('chara', Buffer.from(JSON.stringify(v2)).toString('base64')),
        PNGtext.encode('ccv3', Buffer.from(JSON.stringify(v3)).toString('base64')));
    return encode(chunks);
}
