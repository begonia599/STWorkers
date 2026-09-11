import { Buffer } from 'node:buffer';
import { inflateRawSync, crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { HttpError, parseJsonObject } from './http.js';
import { MAX_ARCHIVE_BYTES } from './extension-repository.js';

const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_INDEX_BYTES = 768 * 1024;
const invalid = cause => {
    if (cause instanceof HttpError && cause.code === 'INVALID_EXTENSION_ARCHIVE') return cause;
    const error = new HttpError(422, 'INVALID_EXTENSION_ARCHIVE', 'The extension archive is malformed, unsafe, unsupported, or exceeds its size limits.');
    if (cause) error.cause = cause;
    return error;
};

export function pluginPath(value) {
    if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f<>:"|?*%#]/.test(value)
        || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid();
    return value;
}

export function inflateEntry(bytes, entry) {
    try {
        if (!entry || ![0, 8].includes(entry.method) || bytes.byteLength !== entry.compressed
            || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ENTRY_BYTES) throw invalid();
        // workerd grows native output buffers in chunks, including the final partial chunk.
        // Bounded headroom avoids false rejections; exact size and CRC remain mandatory below.
        const output = entry.method === 8
            ? inflateRawSync(bytes, { maxOutputLength: entry.size + 64 * 1024 })
            : bytes;
        if (output.byteLength !== entry.size || crc32(output) !== entry.crc) throw invalid();
        return output;
    } catch (error) { throw invalid(error); }
}

export async function inspectArchive(input, signal) {
    if (!input.byteLength || input.byteLength > MAX_ARCHIVE_BYTES) throw invalid();
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const files = Object.create(null);
    const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes,
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (error, value) => error ? reject(invalid(error)) : resolve(value)));
    let root, count = 0, expanded = 0;
    const names = new Set(), ranges = [];
    await new Promise((resolve, reject) => {
        let failed = false;
        const fail = error => { if (!failed) { failed = true; zip.close(); reject(invalid(error)); } };
        zip.on('error', fail);
        zip.on('end', () => { if (!failed) resolve(); });
        zip.on('entry', entry => {
            try {
                if (signal?.aborted || ++count > 5000 || (entry.generalPurposeBitFlag & 1)
                    || ![0, 8].includes(entry.compressionMethod)) throw invalid();
                expanded += entry.uncompressedSize;
                if (expanded > MAX_EXPANDED_BYTES || entry.uncompressedSize > MAX_ENTRY_BYTES) throw invalid();
                const name = pluginPath(entry.fileName.replace(/\/$/, ''));
                const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
                if (![0, 0x8000, 0x4000].includes(mode)) throw invalid();
                const folder = entry.fileName.endsWith('/');
                if ((mode === 0x4000 && !folder) || (mode === 0x8000 && folder)) throw invalid();
                const parts = name.split('/');
                root ??= parts[0];
                if (root !== parts.shift() || (parts.length === 0 && !folder)) throw invalid();
                const relative = parts.join('/');
                if (names.has(name.toLowerCase())) throw invalid();
                names.add(name.toLowerCase());
                if (folder) return zip.readEntry();
                if (relative === '__source.zip') throw invalid();
                zip.readLocalFileHeader(entry, (error, header) => {
                    try {
                        if (failed) return;
                        if (error || header.compressionMethod !== entry.compressionMethod
                            || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
                            || !header.fileName.equals(entry.fileNameRaw)) throw invalid();
                        const descriptor = {
                            offset: header.fileDataStart, compressed: entry.compressedSize,
                            size: entry.uncompressedSize, method: entry.compressionMethod, crc: entry.crc32,
                        };
                        if (!Object.values(descriptor).every(Number.isSafeInteger) || descriptor.offset < 0
                            || descriptor.offset + descriptor.compressed > bytes.byteLength) throw invalid();
                        ranges.push([entry.relativeOffsetOfLocalHeader, descriptor.offset + descriptor.compressed]);
                        // Keep the complete source archive; dotfiles are not served as executable web assets.
                        if (!parts.some(part => part.startsWith('.'))) files[relative] = descriptor;
                        zip.readEntry();
                    } catch (error) { fail(error); }
                });
            } catch (error) { fail(error); }
        });
        zip.readEntry();
    });
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) throw invalid();
    const get = name => {
        const file = Object.hasOwn(files, name) ? files[name] : null;
        if (!file) throw invalid();
        return inflateEntry(bytes.subarray(file.offset, file.offset + file.compressed), file);
    };
    if (!files['manifest.json'] || files['manifest.json'].size > 64 * 1024) throw invalid();
    let manifest;
    try { manifest = parseJsonObject(get('manifest.json')); } catch (error) { throw invalid(error); }
    if (typeof manifest.display_name !== 'string' || !manifest.display_name || manifest.display_name.length > 200
        || (manifest.version !== undefined && (typeof manifest.version !== 'string' || manifest.version.length > 100))) throw invalid();
    const paths = [manifest.js, manifest.css, ...Object.values(manifest.i18n ?? {})].filter(value => value !== '' && value !== undefined);
    if (paths.length > 100) throw invalid();
    for (const name of paths) get(pluginPath(name));
    const index = JSON.stringify({ files });
    if (new TextEncoder().encode(index).byteLength > MAX_INDEX_BYTES) throw invalid();
    return { manifest, index, fileCount: Object.keys(files).length, expandedBytes: expanded };
}
