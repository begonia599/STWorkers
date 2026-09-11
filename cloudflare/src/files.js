import { HttpError } from './http.js';

export class Files {
    constructor(bucket) {
        if (!bucket) throw new HttpError(503, 'FILES_NOT_CONFIGURED', 'The private object storage binding is unavailable.');
        this.bucket = bucket;
    }

    async put(category, bytes, contentType) {
        const key = `${category}/${crypto.randomUUID()}`;
        await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
        return key;
    }

    async get(key) {
        const value = await this.bucket.get(key);
        if (!value) throw new HttpError(404, 'FILE_NOT_FOUND', 'The referenced object is missing.');
        return value;
    }

    async remove(key) {
        await this.bucket.delete(key);
    }

    async cleanup(keys) {
        const pending = [];
        for (const key of new Set(keys.filter(Boolean))) {
            try {
                await this.remove(key);
            } catch {
                pending.push(key);
                console.warn('STworks object cleanup deferred.');
            }
        }
        return pending;
    }
}
