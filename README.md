# PiGallery2 Encrypted

A fork of [PiGallery2](https://github.com/bpatrik/pigallery2), the fast, directory-first photo gallery for low-resource servers (such as a Raspberry Pi).
This fork keeps the whole gallery **encrypted on disk** and decrypts it only while you are viewing it. It also adds basic file management to the gallery, so you can organize your photos without leaving the browser.

This fork is not kept compatible with upstream.

## What is different from upstream

### Encryption at rest
- Photos, videos, sidecar and meta files are stored encrypted (AES-256-GCM). Thumbnails, converted photos and videos, and other generated files are encrypted too.
- Files are decrypted only in memory, while they are sent to your browser or processed.
- The key is protected by the login password of one gallery user. After every restart the gallery is locked until that user logs in. There is no password recovery, so keep the password in a password manager.
- Existing galleries can be encrypted from the web UI (menu, `Encrypt media files`) or with a command line tool. New uploads are encrypted automatically (this can be switched off in the settings).
- File and folder names and the database (metadata cache) are **not** encrypted.

Details, setup steps and limits: [docs/user-guide/encryption.md](docs/user-guide/encryption.md).

### Upload and file management
- Drag and drop (or pick) whole folders to upload; the folder structure is recreated.
- Select photos (checkmark on hover, select all) and move them to another folder.
- Create new folders and rename folders from the gallery.
- Uploading and editing use the same permission (`Upload` / `minimumRole`).

## Keeps the upstream goals
- **Fast**: optimized for low-end hardware.
- **Simple**: point to your photos and you are ready.
- **Directory-first**: shows your folder structure as it is.

## Getting started
Run it with Docker, like upstream. See the upstream [Docker setup guide](https://bpatrik.github.io/pigallery2/setup/docker) and build the image from this repository instead of pulling the upstream image.
Then follow the [encryption guide](docs/user-guide/encryption.md) to turn encryption on.

Other documentation: [configuration](docs/user-guide/configuration.md), [user rights](docs/user-guide/user-rights.md), [upstream documentation site](http://bpatrik.github.io/pigallery2).

## License
MIT, same as upstream.
