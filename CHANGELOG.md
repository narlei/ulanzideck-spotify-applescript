# Changelog

All notable changes to this Spotify plugin for UlanziDeck.

## [2.0.0] - 2026-06-06

### Removed
- **Windows support** — This plugin now supports macOS only, as it relies on AppleScript to control the Spotify desktop app.
- **Spotify Web API** — Replaced entirely with macOS AppleScript. No OAuth, tokens, or local server required.
- **Account & device selectors** — Removed from all property inspector panels. AppleScript controls the local Mac app directly.
- **Toggle Track Like** — Removed because Spotify's AppleScript dictionary does not expose a like/save command.
- **My Playlists / New Releases dial actions** — Removed because they required the Web API.
- **OAuth login flow & local HTTP server** — No longer needed.
- **Bloated property inspectors** — Simplified inspector panels for actions with no configuration. Removed unnecessary inspector HTML files.

### Added
- **Now Playing button** — Displays current track album art with alternating song/artist text overlay.
- **Seek Control dial** — Rotate to seek forward/back by a configurable step size (default 15s). Press to restart track.
- **Instant state feedback** — Play/pause, shuffle, and repeat icons update immediately on press.
- **Zero-dependency WebSocket client** — Hand-rolled WS implementation using only Node.js built-ins.

### Changed
- **Minimum macOS version** — macOS 10.11 or later.
- **Plugin version** — Bumped to 2.0.0 to reflect the major architectural change.
