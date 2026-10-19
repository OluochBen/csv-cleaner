# Repository exposure review

Date: 19 October 2026  
Reviewed main commit: `e9880a51c44c2d6ca14a0ee53321a0fe7e0209a5`

## Scope

A fresh full mirror was inspected, including reachable branch, tag and pull-request refs returned by GitHub: 43 commits, 19 refs, 3,376 unique blob objects, including 3,369 text blobs. This includes historical dependency files, not only the current source tree.

The review checked tracked filenames for environment files, credentials, private keys, upload/export folders, database dumps and CSV/TSV/Excel files. Text was scanned for private-key markers, common provider token formats, credential-bearing URLs, JWT-shaped tokens and quoted secret assignments. First-party email-address matches were also inspected for unexpected data.

## Result

- No confirmed exposed credentials were identified by these checks.
- No tracked customer-export files, database dumps, credential files or upload folders were identified.
- First-party email matches were synthetic `example.com` sample addresses.
- One candidate assignment match occurred in historical bundled Tailwind dependency code and was classified as a placeholder, not a credential.
- Historical commits included `client/node_modules/`. It is absent from current main and ignored. This is a repository-size and hygiene issue; no history rewrite was performed.

## Limits

This was a targeted pattern and filename review, not a comprehensive security audit or provider-side credential validation. Binary objects were inventoried by path but not OCR-scanned or semantically inspected for embedded data. Obfuscated, encrypted or unusual credentials may evade these checks.

Unreachable/deleted objects, other people's forks, issues, PR discussion attachments, CI artifacts, release assets, hosting logs and deployment environment variables were not audited. A clean result does not prove these locations are clean.

If a credential is discovered later, rotate or revoke it first; deleting a current file alone does not remove copies from history or other systems.

## Ongoing handling

- Keep secrets in local or deployment environment settings.
- Never put secrets into `VITE_*` variables, which are public browser configuration.
- Use synthetic fixtures for testing and screenshots.
- Review staged filenames and diffs before pushing.
- Keep dependencies and their licence notices separate from original project rights.
