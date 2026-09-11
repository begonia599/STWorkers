CREATE INDEX IF NOT EXISTS chat_avatar_idx
ON documents (json_extract(payload, '$.avatar')) WHERE kind = 'chat';

CREATE TRIGGER IF NOT EXISTS character_rename_destination_guard
BEFORE UPDATE OF id ON documents
WHEN OLD.kind = 'character' AND NEW.kind = 'character' AND OLD.id <> NEW.id
    AND EXISTS (
        SELECT 1 FROM documents
        WHERE kind = 'chat' AND json_extract(payload, '$.avatar') = NEW.id
    )
BEGIN
    SELECT RAISE(ABORT, 'STWORKS_CHAT_DESTINATION_CONFLICT');
END;

-- The character and all chat pointers move in the same SQLite statement.
-- A destination collision aborts the entire rename, including the character.
CREATE TRIGGER IF NOT EXISTS character_rename_chats
AFTER UPDATE OF id ON documents
WHEN OLD.kind = 'character' AND NEW.kind = 'character' AND OLD.id <> NEW.id
BEGIN
    UPDATE documents
    SET id = json_array(NEW.id, json_extract(payload, '$.file')),
        payload = json_set(payload, '$.avatar', NEW.id),
        revision = revision + 1
    WHERE kind = 'chat' AND json_extract(payload, '$.avatar') = OLD.id;
END;

-- A new snapshot may finish uploading after its character was renamed/deleted.
CREATE TRIGGER IF NOT EXISTS chat_insert_requires_character
BEFORE INSERT ON documents
WHEN NEW.kind = 'chat' AND json_type(NEW.payload, '$.avatar') = 'text'
    AND NOT EXISTS (
        SELECT 1 FROM documents
        WHERE kind = 'character' AND id = json_extract(NEW.payload, '$.avatar')
    )
BEGIN
    SELECT RAISE(ABORT, 'STWORKS_CHAT_CHARACTER_MISSING');
END;
