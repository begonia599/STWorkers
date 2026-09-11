export const STATUS = Object.freeze({
    project: 'STWorkers',
    phase: 'P4-in-progress',
    readyForChat: false,
    upstream: {
        version: '1.18.0',
        commit: '8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8',
    },
    compatibility: {
        originalFrontendBoot: 'partial-local-storage-verified',
        tavernHelper: 'pinned-local-synthetic-partial',
        promptTemplate: 'pinned-local-synthetic-partial',
        communityCards: 'not-yet-verified',
        modelGeneration: 'local-synthetic-verified',
        promptProcessing: 'pinned-functions-and-local-router-verified',
        promptAssembly: 'independent-frontends-local-fixtures-verified',
        nativeVariables: 'slash-swipes-mobile-reload-local-fixtures-verified',
    },
    pluginDelivery: {
        mode: 'bundled-or-owner-installed',
        defaultBundled: false,
        onlineManagement: true,
        repositoryHosts: ['github.com', 'gitlab.com'],
        cloudVerified: false,
        redistributionCleared: false,
    },
    tokenCounting: {
        runtime: 'browser',
        accuracy: 'estimate',
        algorithm: 'stworks-utf8-estimate-v1',
        tokenIds: false,
        backendTokenizers: false,
    },
    implemented: [
        'owner-auth', 'csrf', 'opaque-json-storage', 'settings', 'static-asset-build',
        'presets', 'worldbooks', 'character-png-json', 'chat-snapshots', 'encrypted-model-credentials',
        'browser-token-estimates',
        'native-jsonl-chat-import', 'chat-rename', 'bounded-chat-search',
        'browser-avatar-crop', 'persona-avatars', 'character-rename', 'character-overwrite-import',
        'openai-compatible-generation', 'model-list', 'streaming-and-cancellation', 'custom-request-yaml',
        'prompt-post-processing', 'json-schema-flattening', 'pinned-reasoning-options',
        'opt-in-pinned-plugin-assets',
        'extension-install-update-rollback', 'extension-branches', 'extension-source-download',
    ],
    pending: [
        'community-prompt-variable-regressions', 'real-provider-verification',
        'token-id-encoding-decoding', 'other-chat-import-formats', 'bulk-character-edit',
        'groups', 'community-plugin-verification', 'extension-cloud-verification', 'free-tier-performance',
    ],
    excluded: ['local-model-management', 'server-side-inference', 'voice', 'image-generation'],
});

export const EXCLUDED_API_PREFIXES = ['/api/sd', '/api/speech'];
