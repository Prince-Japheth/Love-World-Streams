# yt-dlp

Downloads and livestream capture are powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) — a single self-contained binary.

The app locates it in this order:

1. The path saved in Settings (via `settings` API).
2. `bin/yt-dlp` inside the packaged app (`process.resourcesPath/bin/yt-dlp`).
3. `yt-dlp` on the system `PATH`.

## Install it

**Packaged app:** drop the `yt-dlp` binary for your platform into this folder
(`bin/yt-dlp`) before building. It ships as an `extraResource` to
`Contents/Resources/bin/yt-dlp`.

**Dev / local run:** either drop it here too, or install via Homebrew:

```sh
brew install yt-dlp
```

### Download the binary (macOS arm64 example)

```sh
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos -o bin/yt-dlp
chmod +x bin/yt-dlp
```

See <https://github.com/yt-dlp/yt-dlp/releases/latest> for other platforms
(`yt-dlp.exe` for Windows, `yt-dlp_linux` for Linux).
