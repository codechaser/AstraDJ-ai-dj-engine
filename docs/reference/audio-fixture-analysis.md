# Audio fixture analysis and evidence limits

Updated 2026-11-03. This document supersedes the earlier pair analysis for release decisions.

## Current release assets

The locally served assets with verified source/license records are Thoughtness and Chill Beat (Wikimedia Commons, CC0 1.0), plus the three clearly labeled demo substitutions from the Ondrosik Free Music Library (CC0 1.0). Their source URLs, notices and checksums are recorded in [`public/audio/NOTICE.md`](../../public/audio/NOTICE.md).

The Night Drive demo substitute has a documented signal-analysis estimate (89 BPM / 5A) tied to its actual local asset checksum. Energy and valence are model estimates, and tempo/key uncertainty is retained in the seed evidence. Blue Horizon and Afterglow Avenue have no complete acoustic profiles. Thoughtness and Chill Beat also remain unprofiled because reliable BPM/key evidence is absent.

## Withdrawn fixture and current segue state

The earlier Ivory Atlas and Faded Fortress MP3s were removed because their licensing/source evidence could not be independently revalidated. Their files are absent from the release tree and rewritten Git refs. Their seed entries retain catalog metadata only: `audioAssetUrl: null`, `acoustic: null`, and `acousticEvidence: null`. Their former tempo, key, emotion, source, license, checksum and playback claims must not be used as current evidence.

There is no verified compatible real-audio pair in the current catalog. The matcher rules remain unchanged: BPM ±8% including permitted half/double-time relationships, allowed Camelot relationships, and deterministic 50/30/20 ranking. Unit tests use explicitly synthetic metadata to test these rules; they do not establish licensed playable tracks. A browser-verified playback segue remains unavailable until two suitable assets and their profiles are independently verified.

Previous benchmark reports and screenshots are retained as historical records. Any run that used the withdrawn pair is not evidence of current release playback, licensing, or segue readiness. No external AI provider or online media source is used by the acoustic matcher.
