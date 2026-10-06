# Mini Shortcuts

A small, self-hosted app directory for a Tailscale network. Open `http://mini/` to see your apps, or type `http://mini/pigeon` to jump to an app's HTTPS address. The address bar changes to the destination URL.

Runs on maintained Node.js 24 LTS (24.21.0 or newer 24.x) with no third-party dependencies. Keep the runtime updated with security releases. Includes optional discovery of sites published with Tailnow. No domain purchase, custom DNS server, or client certificate installation is needed.

## Run locally

Use the latest Node 24 LTS patch. With nvm, run `nvm install` and `nvm use` in this directory; `.nvmrc` selects the 24.x line.

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
- Each `/app-name` or `/app-name/` redirects to its fixed destination. Request query parameters are discarded. Removed entries return 404. There is no destination file-serving API.

## Organize and remove apps

Each card has **Minimize** and **Remove…** controls:

- **Minimize** moves the app into a collapsed section below your main cards. The app keeps running and its shortcut keeps working. **Restore** brings it back to the top.
- **Remove…** opens a confirmation dialog. By default it removes only the directory entry and disables its short redirect. The destination app stays available at its original URL. Open **Removed** to restore the shortcut or shut down the app later.
- Select **Also shut down on the server** to remove the shortcut and stop the selected app. A failed shutdown remains in **Removed**, with a retry control. No app files are deleted.

Layout and removal records are saved across browsers, devices, and server restarts in `apps.state.json` next to `apps.json` (or `<config-name>.state.json` for a custom `MINI_CONFIG`). Keep this private file and its directory writable by the service account. Writes use atomic replacement with mode `0600`; a failed removal write prevents shutdown. Run only one launcher process per state file. Changes to the state file by a local administrator take effect after a launcher restart. A corrupt state file prevents startup rather than silently restoring removed apps.

Tailnow sites can be shut down automatically: the selected site's directory moves to a sibling archive named `<sites-directory>.mini-shortcuts-archive/<slug>-<unique-id>`, outside the served directory. Other sites and the shared Tailnow server keep running. This unpublishes future requests; it does not revoke copies already downloaded by clients. Do not serve or auto-discover the archive directory. Republishing a removed slug does not automatically restore its shortcut.

For a standalone macOS app, configure its exact user LaunchAgent label in the trusted local app entry:

```json
{
  "slug": "pigeon",
  "name": "Pigeon",
  "description": "Files, notes, and reports",
  "url": "https://mini.example-tailnet.ts.net:8443/",
  "service": { "type": "launchAgent", "label": "com.example.pigeon" }
}
```

Shutdown runs `launchctl disable` and `bootout` for that label in the launcher's own GUI user domain, then verifies it is unloaded. Disabling prevents KeepAlive and login from restarting it. Configure only the dedicated app's service, never the launcher itself or a shared service. Unconfigured entries still support minimize/remove; arbitrary processes, remote servers, and system daemons cannot be stopped. LaunchAgent shutdown requires macOS.

To bring a stopped service back, run `launchctl enable gui/<uid>/<label>` and `launchctl bootstrap gui/<uid> /absolute/path/to/agent.plist` on the server. For a stopped Tailnow site, move its archived folder back to `<sites-directory>/<slug>`, or republish it. Then, with the launcher stopped, remove that slug's record from `apps.state.json` and start the launcher again. A shutdown record is deliberately retained until you restore the service and reset its directory state.

Management uses bodyless `POST /api/apps/<slug>/{minimize,restore,remove,shutdown}` requests with `X-Mini-Request: 1`. GET/HEAD never mutate state. Host/origin checks apply and cross-site writes are blocked. Like directory access, management is available to every client permitted by your Tailscale policy; there is no separate admin role. See [SECURITY.md](SECURITY.md).

## Start at login on macOS

Copy `deploy/com.example.mini-shortcuts.plist.example` to `~/Library/LaunchAgents/com.example.mini-shortcuts.plist`. Replace the absolute application, Node executable, and log paths. Keep the service in a stable directory; `server.mjs`, the `public/` directory, and your private `apps.json` must stay together. Create the log directory before loading the agent.

On Apple Silicon Macs using Homebrew, install `node@24` and use `/opt/homebrew/opt/node@24/bin/node` as the agent's executable. This selects Node 24 specifically for the service. Update it periodically with `brew upgrade node@24` and restart the agent to load the updated runtime.

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
