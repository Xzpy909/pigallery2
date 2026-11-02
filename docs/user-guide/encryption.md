# Encryption at rest

PiGallery2 can keep your photos, videos and meta files encrypted on the disk.
They are only decrypted in memory, while they are sent to your browser or processed (indexing, thumbnails, transcoding).
Everything generated from them (thumbnails, face thumbnails, transcoded videos, compressed GPX files) is encrypted too.

!!! warning
    If you lose the passphrase (or key file), **the files can not be recovered**. Keep a copy of it somewhere safe.
    Keep a backup of your gallery before you encrypt it the first time.

## What is and what is not protected

| Protected | Not protected |
|-----------|---------------|
| Content of photos, videos, sidecar (`.xmp`) and meta files (`.gpx`, `.md`, `.pg2conf`) | File and folder names |
| Thumbnails, converted photos and videos, face thumbnails | The database: it is a cache of the metadata read from your photos (keywords, captions, GPS positions, face names, dates, ...) and is stored **unencrypted** |
| New uploads | Anything that runs while a file is viewed: the server holds the key in its memory |

If metadata like GPS positions or captions is sensitive, store the database folder on an encrypted volume too
(e.g.: LUKS, VeraCrypt, BitLocker), or encrypt the whole disk. This feature protects the files themselves,
for example when the disk, a backup or a cloud copy of the photo folder ends up in someone else's hands.

Video transcoding is the only step that needs a plain file for a moment: ffmpeg can not write an mp4 to a stream.
The plain output is written to the `Scratch folder`, encrypted, then overwritten and deleted.
Point the `Scratch folder` to a RAM disk (e.g.: `/dev/shm`) if you want it to never touch the disk.

## Setting it up

1. Choose a passphrase. Set it with the `PG2_ENCRYPTION_PASSPHRASE` environment variable
   (or in `Encryption` / `Passphrase`, or put it in a file and set `Encryption` / `Key file`).
   Prefer the environment variable or the key file, so the passphrase is not stored next to the data it protects.
   The key file can hold 64 hex characters (a raw 256 bit key) or any text that is used as a passphrase.
2. Stop the server and **back up your photo folder**.
3. Encrypt the existing files. This replaces the files one by one, and checks each encrypted copy
   by decrypting it again before it replaces the original:

   ```bash
   # shows what would be encrypted
   PG2_ENCRYPTION_PASSPHRASE='your passphrase' node ./src/backend/tools/EncryptGallery
   # does it
   PG2_ENCRYPTION_PASSPHRASE='your passphrase' node ./src/backend/tools/EncryptGallery --apply
   ```

   It takes the same options as the server (e.g.: `--config-path=...`). It can be stopped and started again:
   files that are already encrypted are skipped. When it is done, the old thumbnails are deleted
   (they are regenerated, encrypted, when needed).
4. Enable `Encryption` / `Enabled` and start the server. The tool changes the timestamps of the folders,
   so the gallery re-indexes them on its own; you can also start the Indexing job from the settings.

New uploads are encrypted before they reach the disk.
Files that are not encrypted yet are still shown, so you can switch it on before the tool has finished.

## Behavior

* The server **refuses to start** if encryption is enabled and there is no key, or if the key is not the one the gallery was encrypted with.
  It never silently starts with a new key.
* The salt of the key derivation is stored in `.pg2-encryption.json` in the photo folder. It is not secret, but it has to stay with the files.
  Do not delete it.
* The photo folder needs write permission (the tool replaces the files, and the server stores the salt).
* Downloads (single files and zip) are decrypted, you get the original files.
* To turn it off, run the tool with `--decrypt --apply`, then disable `Encryption` / `Enabled`.

## How it works

Files are split to 64 KiB chunks and encrypted with AES-256-GCM. Every file has its own key,
derived (HKDF-SHA256) from the master key and a random salt that is stored in the file header.
The master key is derived from your passphrase with scrypt.
Every chunk is authenticated on its own, together with its position and whether it is the last one,
so changed, reordered, swapped or cut-off chunks are detected, and a part of a file (e.g.: for seeking in a video)
can be decrypted without reading the rest of it.
