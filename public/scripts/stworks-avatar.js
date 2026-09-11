export const MAX_AVATAR_PIXELS = 16 * 1024 * 1024;
export const MAX_AVATAR_EDGE = 8192;
export const MAX_AVATAR_BYTES = 7 * 1024 * 1024;

function dimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > MAX_AVATAR_EDGE || height > MAX_AVATAR_EDGE || width * height > MAX_AVATAR_PIXELS) {
        throw new Error('Avatar dimensions exceed the supported limit (8192 per side, 16 megapixels).');
    }
}

export function avatarGeometry(width, height, crop) {
    dimensions(width, height);
    if (crop === undefined) return { x: 0, y: 0, width, height, outputWidth: width, outputHeight: height };
    if (!crop || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(crop[key]))) {
        throw new Error('Invalid avatar crop coordinates.');
    }
    const [x, y, w, h] = [crop.x, crop.y, crop.width, crop.height].map(Math.round);
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
        throw new Error('Avatar crop is outside the image.');
    }
    // Match the upstream cover operation if a caller supplies a different aspect ratio.
    const outputWidth = crop.want_resize ? 512 : w;
    const outputHeight = crop.want_resize ? 768 : h;
    const scale = Math.max(outputWidth / w, outputHeight / h);
    const sourceWidth = outputWidth / scale;
    const sourceHeight = outputHeight / scale;
    return {
        x: x + (w - sourceWidth) / 2, y: y + (h - sourceHeight) / 2,
        width: sourceWidth, height: sourceHeight, outputWidth, outputHeight,
    };
}

// Avatar uploads only: character-card imports must retain their embedded PNG metadata.
export async function prepareAvatarUpload(form, crop) {
    const file = form.get('avatar');
    if (!(file instanceof Blob) || !file.size) return;
    if (file.size > 8 * 1024 * 1024) throw new Error('Avatar source exceeds the 8 MiB upload limit.');
    let image;
    const canvas = document.createElement('canvas');
    try {
        image = await createImageBitmap(file);
        const box = avatarGeometry(image.width, image.height, crop);
        canvas.width = box.outputWidth;
        canvas.height = box.outputHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The browser could not create an avatar canvas.');
        context.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
        const png = await new Promise((resolve, reject) => canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('The browser could not encode the avatar.'));
        }, 'image/png'));
        if (png.size > MAX_AVATAR_BYTES) throw new Error('The processed avatar exceeds 7 MiB. Select a smaller crop.');
        form.set('avatar', png, 'avatar.png');
    } finally {
        image?.close();
        canvas.width = canvas.height = 0;
    }
}
