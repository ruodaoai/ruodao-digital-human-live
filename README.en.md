# Digital Human Live

Turn one photo into a 24/7 vertical live stream. Realistic or cartoon avatars, lip-sync and motion, AI script rotation, local speech synthesis, subtitles, and one-click RTMP push to Douyin, Kuaishou, WeChat Channels, Bilibili and YouTube - or use it as an OBS / Live Companion browser source.

## What it does

- **Avatar from a single photo** - lip-sync driven by MuseTalk / Wav2Lip style pipelines, with idle motion and expression.
- **1080x1920 vertical stage** - background, avatar framing, captions and overlays composed for a phone screen.
- **AI script rotation** - generate and loop talk tracks; keep the same persona across sessions.
- **Local TTS and subtitles** - synthesize speech on the machine and burn or overlay subtitles.
- **One-click RTMP push** - preset targets for Douyin / Kuaishou / WeChat Channels / Bilibili / YouTube, plus a browser-source mode for OBS or the platform's Live Companion.
- **Web reception agent** - embed the avatar into your product page for one-to-many live, one-to-one queued reception, or round-robin reception, with typed or voice interaction backed by Ruodao models.

## Requirements

- Ruodao desktop host (Windows).
- A GPU is recommended for lip-sync; CPU works at lower frame rates.
- Python runtime is provisioned by the plugin on first use.

## Permissions and privacy

- `process`, `network`, `clipboard`, local storage.
- Photos, audio and rendered frames stay on the local disk; uploading only happens when you start a stream to a platform you configured.

## Links

- Marketplace: https://ruodao.com/plugin-market

## License

MIT
