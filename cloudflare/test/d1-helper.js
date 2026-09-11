import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function makeD1(t) {
    const sqlite = new DatabaseSync(':memory:');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
        sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    t.after(() => sqlite.close());
    return {
        sqlite,
        prepare(sql) {
            return {
                bind(...parameters) {
                    return {
                        async first() {
                            const row = sqlite.prepare(sql).get(...parameters);
                            return row ? { ...row } : null;
                        },
                        async all() {
                            return { results: sqlite.prepare(sql).all(...parameters).map(row => ({ ...row })) };
                        },
                        async run() {
                            const before = sqlite.prepare('SELECT total_changes() AS count').get().count;
                            sqlite.prepare(sql).run(...parameters);
                            const after = sqlite.prepare('SELECT total_changes() AS count').get().count;
                            return { success: true, meta: { changes: Number(after - before) } };
                        },
                    };
                },
            };
        },
    };
}

export const syntheticCardState = {
    chat_metadata: { variables: { chapter: 3, flags: ['visited'] }, unknown_metadata: { future: true } },
    messages: [
        {
            name: 'Example character',
            is_user: false,
            mes: 'Second reply',
            swipes: ['First reply', 'Second reply'],
            swipe_id: 1,
            variables: [{ stat_data: { score: 2 } }, { stat_data: { score: 7 } }],
            extra: { unknown_plugin_field: { nested: [false, null, 0, ''] } },
        },
    ],
    extension_settings: { variables: { global: { visits: 9 } }, unknown_extension: { enabled: true } },
    extensions: { tavern_helper: { scripts: [{ id: 'synthetic-script', content: '/* inert fixture */' }] } },
    future_card_field: { preserve: true },
};
