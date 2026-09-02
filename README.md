# MapleLegends Boss Timer

[![Release](https://img.shields.io/github/v/release/superjump22/mlboss-timer?style=flat-square&color=4ade80)](https://github.com/superjump22/mlboss-timer/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com/superjump22/mlboss-timer/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-gray?style=flat-square)](#license)

Boss skill timer client for MapleLegends: a floating overlay panel with bossassis room sync — teammates can keep using the official web version in the same room.

Currently supported boss: AUF (more coming).

## Screenshots

<table>
  <tr>
    <td><img src="docs/screenshots/overlay.png" width="380" alt="Overlay · in-game timer"/></td>
    <td><img src="docs/screenshots/main.png" width="380" alt="Main client · control center"/></td>
  </tr>
  <tr>
    <td align="center">Overlay · in-game timer</td>
    <td align="center">Main client · control center</td>
  </tr>
</table>

## Features

- Floating overlay above the game: click-through when locked, follows game window movement and scales proportionally
- Room sync with bossassis.com web clients (zero migration for teammates)
- Ready alerts: bilingual voice / beep / mute
- Main / clone skill groups, multi-client tracking switch
- System tray, adjustable opacity & UI scale, English / Chinese
- UI hot updates (EdgeOne Pages) + client update checks (GitHub Releases)

## Download

Get the latest installer from [Releases](https://github.com/superjump22/mlboss-timer/releases/latest).

> Your browser may warn about a "dangerous file": the installer is unsigned (code signing certs are costly for indie devs). This is normal — choose "Keep". If in doubt, verify on [VirusTotal](https://www.virustotal.com) first.

## Development

```
cd shell
npm install
npm run dev        # frontend :5173
cargo build --manifest-path src-tauri/Cargo.toml   # shell (requires Tauri 2 / Rust / WebView2)
```

## Build

```
cd shell
npm run build
cargo tauri build --manifest-path src-tauri/Cargo.toml   # produces NSIS installer
```

## License

MIT
