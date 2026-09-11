import path from 'node:path';

export function selectPublicFiles(trackedPaths) {
    return trackedPaths.filter(file => file.startsWith('public/')).map(file => {
        const relative = file.slice('public/'.length);
        if (!relative || relative.includes('\\') || relative.includes('\0')
            || path.posix.isAbsolute(relative)
            || relative.split('/').some(part => part === '..' || part === '.' || part === '')) {
            throw new Error(`Invalid tracked public path: ${file}`);
        }
        return { source: file, relative };
    });
}
