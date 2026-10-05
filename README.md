# Mini Shortcuts

A small, self-hosted app directory for a Tailscale network. Open `http://mini/` to see your apps, or type `http://mini/pigeon` to jump to an app's HTTPS address. The address bar changes to the destination URL.

Runs on Node.js 24 or later with no third-party dependencies. Includes optional discovery of sites published with Tailnow. No domain purchase, custom DNS server, or client certificate installation is needed.

## Run locally

```sh
cp apps.example.json apps.json
# Edit apps.json with your real destinations and allowed hosts.
npm start
```

Open `http://127.0.0.1:8790/`. The listener always binds to IPv4 loopback. `PORT` changes the port; `MINI_CONFIG` selects a different configuration file. If you change the port, update `allowedHosts` too. No dependency installation is required.

## Private Tailscale setup

Enable MagicDNS on your tailnet. Use your device's existing short name or choose one such as `mini`. Renaming a device changes its full Tailscale DNS name too: update existing applications and saved URLs before relying on the new name. This repository does not rename devices or change existing routes automatically.

Add the short device name and its actual full Tailscale name to `allowedHosts`, then run:

```sh
tailscale serve --bg --http=80 http://127.0.0.1:8790
```

On macOS the CLI may be at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Check `tailscale serve status` first; the command above replaces an existing handler on HTTP port 80. It does not need to replace your other apps' HTTPS routes. Do not use `tailscale serve reset` to remove this service: that also removes other Serve routes. Use `tailscale serve --http=80 off` instead.

Connect client devices to Tailscale with Tailscale DNS enabled, then open `http://mini/` (substitute your device name). Include `http://` if the browser otherwise performs a search. Keep the host online and, on macOS, logged in for its LaunchAgent to run.

See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [MagicDNS](https://tailscale.com/docs/features/magicdns).

## Configuration

`apps.json` is local-only and ignored by Git. Example:

```json
{
  "allowedHosts": ["localhost:8790", "127.0.0.1:8790", "mini", "mini.example-tailnet.ts.net"],
  "apps": [
    {
      "slug": "pigeon",
      "name": "Pigeon",
      "description": "Files, notes, and reports",
      "url": "https://mini.example-tailnet.ts.net:8443/"
    }
  ],
  "tailnow": {
    "directory": "/absolute/path/to/Tailnow/sites",
    "url": "https://mini.example-tailnet.ts.net/"
  }
}
```

- Omit `tailnow` if you do not use it. Its directory must exist. Its HTTPS base URL must end in `/` and contain no query or fragment.
- Explicit apps override discovered apps with the same slug. Slugs are case-sensitive, 1–80 letters, digits, underscores, or hyphens. Symlinks and other directory entries are ignored.
- Destinations must use HTTPS without embedded usernames or passwords. The local configuration is trusted: only add destinations you intend to visit. The service does not fetch or verify their content.
- Configuration and directory changes appear on the first request after the one-second cache expires. An invalid reload returns a generic 503 until repaired; it does not continue serving stale entries.
- Limits: 128 KiB configuration, 500 apps, and 2,000 entries scanned in the Tailnow directory. App names are at most 120 characters and descriptions at most 300.
- Each `/app-name` or `/app-name/` redirects to its fixed destination. Request query parameters are discarded. There is no management or file-serving API.

## Start at login on macOS

Copy `deploy/com.example.mini-shortcuts.plist.example` to `~/Library/LaunchAgents/com.example.mini-shortcuts.plist`. Replace the absolute application, Node executable, and log paths. Keep the service in a stable directory; `server.mjs`, `public/style.css`, and your private `apps.json` must stay together. Create the log directory before loading the agent.

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.example.mini-shortcuts.plist
launchctl kickstart -k "gui/$(id -u)/com.example.mini-shortcuts"
```

To stop it, use `launchctl bootout "gui/$(id -u)/com.example.mini-shortcuts"`. This template starts after login, not before login. Keep private backups and installed plists outside the repository.

## Development and security

```sh
npm test
```

Tests use temporary configuration and loopback listeners; they do not touch installed apps or Tailscale settings. [SECURITY.md](SECURITY.md) describes the trust boundary and review findings.

The launcher is intended for people/devices already allowed to reach it by your Tailscale policy. It does not provide per-user authorization. App names and destinations are visible to those clients; each destination app remains responsible for its own authentication. Publish the source, not your private `apps.json`, logs, backups, or installed service configuration.
