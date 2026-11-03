# Acoustic profile validation — superseded release status

Updated 2026-11-03. This file replaces the prior validation conclusion for release readiness.

The former Ivory Atlas and Faded Fortress test pair depended on MP3 assets and source/licensing claims that could not be independently revalidated during GitHub preparation. Both MP3 files have been removed from the release tree and all Git refs. Their track records remain in the catalog seed for metadata continuity, but the seed now sets `audioAssetUrl`, `acoustic`, and `acousticEvidence` to `null`; its upsert will clear those fields if run against a deliberately selected database. No live Atlas database was modified.

Consequently, there is no current verified compatible pair for real playback-driven segue testing. Prior acoustic measurements and browser segue results for this pair are historical artifacts only and must not be treated as current license, profile, or playback evidence.

The existing matcher and its BPM/Camelot constraints and 50/30/20 ranking are unchanged. Its synthetic unit fixtures continue to test the rules, but no real-catalog segue acceptance or performance target is claimed.

For the remaining currently verified audio sources and the one retained Night Drive acoustic estimate, see [`docs/reference/audio-fixture-analysis.md`](reference/audio-fixture-analysis.md) and [`public/audio/NOTICE.md`](../public/audio/NOTICE.md).
