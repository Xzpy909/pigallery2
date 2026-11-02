# Encryption at rest

PiGallery2 can keep your photos, videos and meta files encrypted on the disk.
They are only decrypted in memory, while they are sent to your browser or processed (indexing, thumbnails, transcoding).
Everything generated from them (thumbnails, face thumbnails, transcoded videos, compressed GPX files) is encrypted too.

The key is protected by the **login password of one gallery user**. After a restart the gallery is locked:
nobody can log in or see anything until that user logs in. Their login unlocks the gallery for everybody.

!!! warning
    If you lose that password, **the files can not be recovered**. There is no reset.
    Store it in a password manager, and keep a backup of your gallery before you encrypt it the first time.

## What is and what is not protected

| Protected | Not protected |
|-----------|---------------|
| Content of photos, videos, sidecar (`.xmp`) and meta files (`.gpx`, `.md`, `.pg2conf`) | File and folder names |
| Thumbnails, converted photos and videos, face thumbnails | The database: it is a cache of the metadata read from your photos (keywords, captions, GPS positions, face names, dates, ...) and is stored **unencrypted** |
| New uploads | Anything that runs while the gallery is unlocked: the server holds the key in its memory |

If metadata like GPS positions or captions is sensitive, store the database folder on an encrypted volume too
(e.g.: LUKS, VeraCrypt, BitLocker), or encrypt the whole disk. This feature protects the files themselves,
for example when the disk, a backup or a cloud copy of the photo folder ends up in someone else's hands.

Video transcoding is the only step that needs a plain file for a moment: ffmpeg can not write an mp4 to a stream.
The plain output is written to the `Scratch folder`, encrypted, then overwritten and deleted.
Point the `Scratch folder` to a RAM disk (e.g.: `/dev/shm`) if you want it to never touch the disk.

The password of the unlock user is also the encryption key, so its strength is the strength of the encryption.
Use a long, random password (at least 8 characters are required).

## Setting it up

There are two ways: from the web UI (easiest), or with a command line tool.

### From the web UI

1. Create your real admin account, delete the default `admin`, and log in with the new account.
2. **Back up your photo folder.**
3. Open the menu, `Encrypt media files`. Confirm your password and press `Encrypt everything`.
   The password is checked against your account, then it becomes the key of the gallery. A background job
   (`Media encryption`, also listed in the settings under Jobs) encrypts the files with a progress log.
4. Later, new files copied into the photo folder directly are encrypted by the same page
   (`Encrypt files that are not encrypted yet`). Uploads through the app are encrypted automatically.

### With the command line tool

1. Create your real admin account, delete the default `admin` account, and check that you can log in.
   (Use the account whose password should unlock the gallery.)
2. Stop the server and **back up your photo folder**.
3. Encrypt the existing files. This replaces the files one by one, and checks each encrypted copy
   by decrypting it again before it replaces the original. The tool asks for the login password of that user (hidden):

   ```bash
   # shows what would be encrypted
   node ./src/backend/tools/EncryptGallery --user=<name>
   # does it
   node ./src/backend/tools/EncryptGallery --user=<name> --apply
   ```

   It takes the same options as the server (e.g.: `--config-path=...`). It checks the password against the gallery's
   user database, so it has to be a real login password. For scripts, set the `PG2_ENCRYPTION_PASSWORD`
   environment variable or pipe the password into the standard input.
   It can be stopped and started again: files that are already encrypted are skipped.
   When it is done, the old thumbnails are deleted (they are regenerated, encrypted, when needed).
4. Start the server. It is locked: log in as that user, and the gallery works. The tool changes the timestamps of
   the folders, so the gallery re-indexes them on its own; you can also start the Indexing job from the settings.

With Docker, stop the container and run the tool in a one-off container, for example:
`docker compose run --rm -it --entrypoint node pigallery2 ./src/backend/tools/EncryptGallery --config-path=/app/data/config/config.json --user=<name> --apply`

New uploads are encrypted before they reach the disk.
Files that are not encrypted yet are still shown, so you can start the server before the tool has finished.

## Behavior

* After every start the gallery is **locked**. Every request is answered with "not authenticated", sharing links
  do not work, and indexing or thumbnail jobs fail instead of producing empty results. Other users can only log in
  after the unlock user did.
* Because logging in is the only way to unlock, `Users` / `Authentication required` must stay enabled.
  The server refuses to start otherwise.
* Changing the password of the unlock user in the app re-protects the key with the new password automatically.
  Changing it **outside the app** (e.g.: editing the database) makes the gallery impossible to unlock.
  The unlock user can not be deleted, and the OpenID login can not unlock the gallery.
* The wrapped key is stored in `.pg2-encryption.json` in the photo folder. It is useless without the password, but it has
  to stay with the files. Do not delete it.
* The photo folder needs write permission (the tool replaces the files and stores the key file).
* Downloads (single files and zip) are decrypted, you get the original files.
* To turn it off, run the tool with `--decrypt --apply`. The key file is removed when all files are plain again.

## How it works

Files are split to 64 KiB chunks and encrypted with AES-256-GCM. Every file has its own key,
derived (HKDF-SHA256) from the master key and a random salt that is stored in the file header.
The master key is random. It is encrypted (AES-256-GCM) with a key derived from the login password with scrypt,
and bound to the user name.
Every chunk is authenticated on its own, together with its position and whether it is the last one,
so changed, reordered, swapped or cut-off chunks are detected, and a part of a file (e.g.: for seeking in a video)
can be decrypted without reading the rest of it.
