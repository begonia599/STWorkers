import { HttpError, MAX_JSON_BYTES } from './http.js';

function serializeDocument(value) {
    const payload = JSON.stringify(value);
    if (typeof payload !== 'string') {
        throw new HttpError(400, 'INVALID_DOCUMENT', 'The document must be JSON serializable.');
    }
    if (new TextEncoder().encode(payload).byteLength > MAX_JSON_BYTES) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The document limit is 1 MiB.');
    }
    return payload;
}

export class Documents {
    constructor(database) {
        if (!database) {
            throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'The D1 binding is unavailable.');
        }
        this.database = database;
    }

    async get(kind, id) {
        const row = await this.database.prepare(
            'SELECT payload, revision, updated_at FROM documents WHERE kind = ? AND id = ?',
        ).bind(kind, id).first();
        if (!row) return null;
        return {
            id,
            value: JSON.parse(row.payload),
            revision: row.revision,
            updatedAt: row.updated_at,
        };
    }

    async list(kind) {
        const { results } = await this.database.prepare(
            'SELECT id, payload, revision, updated_at FROM documents WHERE kind = ? ORDER BY id',
        ).bind(kind).all();
        return results.map(row => ({
            id: row.id, value: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at,
        }));
    }

    async remove(kind, id, expectedRevision) {
        const statement = expectedRevision === undefined
            ? this.database.prepare('DELETE FROM documents WHERE kind = ? AND id = ?').bind(kind, id)
            : this.database.prepare('DELETE FROM documents WHERE kind = ? AND id = ? AND revision = ?')
                .bind(kind, id, expectedRevision);
        const result = await statement.run();
        if (expectedRevision !== undefined && result.meta.changes !== 1) {
            throw new HttpError(409, 'REVISION_CONFLICT', 'The document changed. Reload before deleting.');
        }
        return result.meta.changes > 0;
    }

    async put(kind, id, value, expectedRevision) {
        const payload = serializeDocument(value);
        if (expectedRevision !== undefined) {
            const statement = expectedRevision === 0
                ? this.database.prepare('INSERT INTO documents (kind, id, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
                    .bind(kind, id, payload)
                : this.database.prepare(`UPDATE documents SET payload = ?, revision = revision + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE kind = ? AND id = ? AND revision = ?`).bind(payload, kind, id, expectedRevision);
            const result = await statement.run();
            if (result.meta.changes !== 1) {
                throw new HttpError(409, 'REVISION_CONFLICT', 'The document changed. Reload before saving again.');
            }
            return;
        }
        await this.database.prepare(`
            INSERT INTO documents (kind, id, payload) VALUES (?, ?, ?)
            ON CONFLICT(kind, id) DO UPDATE SET
                payload = excluded.payload,
                revision = documents.revision + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        `).bind(kind, id, payload).run();
    }

    async rename(kind, id, destination, value, expectedRevision) {
        const payload = serializeDocument(value);
        // One statement moves the pointer only if the source is unchanged and the destination is free.
        const result = await this.database.prepare(`
            UPDATE documents SET id = ?, payload = ?, revision = revision + 1
            WHERE kind = ? AND id = ? AND revision = ?
              AND NOT EXISTS (SELECT 1 FROM documents WHERE kind = ? AND id = ?)
        `).bind(destination, payload, kind, id, expectedRevision, kind, destination).run();
        // D1 counts trigger writes too; a character rename can also update many chat rows.
        if (result.meta.changes < 1) {
            throw new HttpError(409, 'REVISION_CONFLICT', 'The source changed or the destination already exists.');
        }
    }
}
