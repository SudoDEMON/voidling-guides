# Voidling Guides

Voidling Guides is a kid-friendly LAN page for requesting game guides. A guide
can cover a badge, character, morph, skin, secret, item, or mechanic. The app
searches YouTube with a locked game/guide query, asks Google Antigravity to
select an exact and apparently child-appropriate result, downloads it as a local
WebM, and serves it without sending the child to YouTube.

The page uses the animated VOiDling sprite and the standard black, `#1793D1`,
and `#D15517` color palette.

## Start it

Requirements:

- Node.js 22 or newer
- authenticated Antigravity CLI (`agy`)
- `yt-dlp`
- `ffmpeg` and `ffprobe`

Check the machine:

```bash
npm run doctor
```

If Antigravity has not been authenticated yet, run `agy` once and sign in. Then
start the site:

```bash
npm run web
```

The kids open the server's LAN address, for example:

```text
http://192.168.1.50:3002
```

All page links, API requests, and video URLs are host-relative. Opening the site
from another computer therefore stays on the address that computer opened; the
Home link never substitutes the server's localhost address.

The process stays attached to the terminal. Press `Ctrl+C` to stop it.

## Dad Approval page

Set the Dad password once from an interactive terminal. The command masks the
password while you type and stores only a salted scrypt hash in the ignored
`data/admin-auth.json` file:

```bash
npm run set-password
```

Then open `/dad` using the same Voidling Guides address from any device allowed
by the LAN client list, for example:

```text
http://192.168.1.50:3002/dad
```

The page lets Dad add approved games, review and correct kid requests, inspect
the append-only audit log, and add or replace a guide's approved YouTube video.
It validates video URLs, metadata, captions, and public availability before
updating the local catalog. After approval succeeds, the app immediately queues
the video for download and serves it from the kids' library when conversion
finishes; the child does not need to submit a second request.

Dad can also remove manually approved video links, game requests, guide/library
entries, and approved games. Every removal asks for confirmation and is written
to the append-only audit log. Removing a completed library entry permanently
deletes its managed WebM file; removing only an approved video link leaves any
already downloaded library copy alone. A game cannot be removed until its
related library entries have been removed, which prevents orphaned videos.

If a game is missing from the kids' dropdown, the child can submit its platform
and full game name for Dad to review. This does not search YouTube or download
anything. Dad can approve or decline it from `/dad`; approval adds the game to
the dropdown, which refreshes automatically.

The entire `/dad` route tree uses the same configured client allowlist as the
kids' page, so devices outside the approved LAN are rejected before the login
page is served. Every approved LAN device can see the login form, but reading
Dad data or performing Dad actions requires the password. Login uses an
eight-hour in-memory session with an HTTP-only, SameSite-Strict cookie;
restarting the server locks the page again. Run `npm run set-password` again at
any time to replace the stored password. No default password exists.

The built-in server uses plain HTTP. Use the Dad portal only on a trusted LAN,
because its password and session traffic are not encrypted in transit. For an
untrusted network, add HTTPS through a reverse proxy or connect through a
trusted VPN instead of widening the allowlist.

## LAN access

The server binds to `0.0.0.0:3002`, but a fresh clone allows only localhost.
Configure the local LAN subnet once; this writes an ignored `data/settings.json`:

```bash
npm run configure-lan -- 192.168.1.0/24
```

CIDR support lets every device in the selected subnet use both the kid-facing
page and the password-protected Dad login. For a temporary override, set a
comma-separated `VOIDLING_ALLOWED_CLIENTS`; use `*` only when every device that
can reach the port should have access. The host and port can be changed with
`VOIDLING_HOST` and `VOIDLING_PORT`.

On systems using UFW with a default-drop input policy, allow that same subnet:

```bash
npm run firewall -- add 192.168.1.0/24
```

Remove the rule later with:

```bash
npm run firewall -- remove 192.168.1.0/24
```

The helper changes no other UFW rules. It is intentionally not run by the web
application because it requires your sudo password and changes machine-level
network access.

## Approve games and known guides manually

The Dad Approval page is the normal way to pin a guide. You can also edit
the ignored `data/approved-guides.md` locally. A level-two heading
approves a game and adds it to the dropdown:

```markdown
## Roblox: Example Game
```

An optional Markdown link pins a Dad-approved video for a guide. Pinned videos
skip Antigravity selection but still receive YouTube metadata and file checks:

```markdown
- [Example Guide](https://www.youtube.com/watch?v=VIDEO_ID)
```

The application creates the local catalog from
[`approved-guides.example.md`](approved-guides.example.md) on first start. Save
manual edits, then request the exact guide name. Direct edits remain passive;
using the Dad Approval form instead validates and downloads the video
immediately. The catalog is re-read for every request, so normal edits do not
require a server restart.

## Request flow and safeguards

1. The child can select only an approved game and enter a 2–64 character guide
   name or topic.
   Missing games can be sent to Dad as a name-only approval request.
2. The server rejects URLs, prompt-injection phrases, and clearly unsafe terms.
3. `yt-dlp` searches for up to five candidates at a time using only the approved
   game and sanitized guide name. If a strict quoted search has no plausible
   result, two natural-language query variants improve recall without widening
   the subject matter.
4. Age-restricted, live, unavailable, unsafe-metadata, and unrelated candidates
   are rejected. Available English captions receive an additional term scan.
5. `agy --mode plan --sandbox` receives only sanitized candidate metadata and
   must return an exact result plus the complete canonical guide name.
6. If the complete name is more specific than the request, the page pauses and
   asks **Did you mean this guide?**
   Nothing downloads until the child answers Yes. The prompt survives refreshes
   and server restarts, and both answers are recorded in the parent audit log.
7. The chosen video is downloaded directly as VP9/Opus WebM when possible. A
   local ffmpeg WebM transcode is used when compatible streams are unavailable.
8. `ffprobe` verifies the completed file before it appears in the library.

The workflow fails closed. When no exact result can be verified, the page says:

> I couldn't find the exact guide. Please go get approval from your Dad for the
> video first.

This reduces accidental or deliberately inappropriate searches, but metadata
and automated review cannot guarantee every externally created video's content.
Use a pinned guide when a specific video needs explicit parental approval.

Only one download runs at a time. Up to five more requests may wait in the
queue, clients have a 30-second request cooldown, and duplicate game/guide
requests reuse the existing job or video.

## Local data and audit log

Generated data is ignored by Git and stored under `data/`:

- `data/library.json` — persistent job/library state
- `data/settings.json` — local client allowlist/CIDR configuration
- `data/approved-guides.md` — local approved games and pinned videos
- `data/videos/<game>/<guide>.webm` — completed local guides
- `data/request-log.md` — append-only parent audit log
- `data/admin-auth.json` — salted Dad password hash, readable only by this user

The audit log is never served by the web application. It records request time,
game, searched guide, requesting client IP, success/failure, the video served,
canonical YouTube URL, and the Antigravity selection response. Example:

```text
[2026-01-01T18:30:00.000Z - SERVED - Example Game - Example Guide - Example guide title - client=192.168.1.42 - https://www.youtube.com/watch?v=VIDEO_ID - AGY=SELECT|SAFE|EXACT|VIDEO_ID|Example Guide|Exact guide]
```

Completed videos and their library cards are deleted seven days after
completion. Failed cards are deleted after 24 hours. The append-only request log
is retained and is not affected by cleanup. Pending game requests remain until
Dad reviews them; approved or declined requests are removed after 30 days. There
is no duration or total-size cap.

## VOiDling mascot

The active 1536×1872 transparent sprite sheet is stored at
`public/voidling-weightless-float.png`; its grid has eight columns, nine
rows, and 192×208 cells. The homepage animates the first six frames of the
typing row (zero-based row `7`). The original supplied `voidling-assets.zip`
stays local and is ignored by Git. See `public/README.md` for the complete sheet
layout.

## Development

```bash
npm test
npm run doctor
node --check server.js
```

GitHub Actions run the Node test suite and a full-history Gitleaks scan on pushes
and pull requests. Keep all machine-specific settings, approved games, request
history, authentication data, and downloaded media under the ignored `data/`
directory.

The service intentionally has no runtime npm dependencies. Its HTTP surface is
limited to static site assets, three kid-facing read APIs, the request and
confirmation APIs, registered completed-video playback with HTTP byte ranges,
and the separately authenticated Dad routes available to approved LAN clients.
