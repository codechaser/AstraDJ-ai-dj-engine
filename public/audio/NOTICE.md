# Audio asset notice

`thoughtness.ogg` is a 46-second original instrumental song created in GarageBand by Kian Moretz and released by its copyright holder under the Creative Commons CC0 1.0 Universal Public Domain Dedication.

The Ogg/Vorbis stream reports 44.1 kHz and 2,034,432 samples, which is 46.1322449 seconds. The catalog stores the rounded duration (46 seconds); completion reporting permits at most a one-second difference between catalog and browser-reported duration.

- Source and license record: https://commons.wikimedia.org/wiki/File:Thoughtness.ogg
- License deed: https://creativecommons.org/publicdomain/zero/1.0/
- Original media: https://upload.wikimedia.org/wikipedia/commons/8/89/Thoughtness.ogg
- SHA-1 of the committed Ogg file: `eeb6576c9f1ec1667dabca85bb7a5dc385c773b1`
- SHA-256 of the committed Ogg file: `f79dad2d56bc3be910d44724fde53dfb88be3d07315acb44aca70211a40cfe2c`

The track is seeded into the catalog as `t_cc0_thoughtness` and appears as a labeled demo item in the existing Playlist preview. It has no verified acoustic analysis, so its acoustic profile is `null`, segue matching rejects it, and the acoustic-profile endpoint returns `409 ACOUSTIC_PROFILE_UNAVAILABLE`. Its use does not imply that the existing fictional catalog tracks have audio.

`chill-beat.ogg` is a CC0 1.0 recording titled “Chill Beat” by Maddy (Wikimedia Commons user Coolgurl5555). Attribution is not required by CC0; the credit is retained here for traceability. The Ogg/Vorbis file is stereo, 44.1 kHz and 96.1806122 seconds (4,241,565 frames).

- Source and license record: https://commons.wikimedia.org/wiki/File:Chill_Beat.ogg
- License deed: https://creativecommons.org/publicdomain/zero/1.0/
- Original media: https://upload.wikimedia.org/wikipedia/commons/9/9f/Chill_Beat.ogg
- SHA-256 of the committed Ogg file: `0ebeaac7ed3e8fab0beb2a707d7e2eb048d673583d32d9dccba9a2be9f8e075b`

The track is seeded as `t_cc0_chill_beat`. It currently has `acoustic: null`: see `docs/reference/audio-fixture-analysis.md` for measured signal features, model-estimated emotion values, confidence limitations, and why a complete matching profile has not been assigned.

Two catalog entries previously referenced two MP3s whose license and source records could not be independently verified during release preparation. Those MP3s have been removed from the release tree and Git history; their historical hashes/source claims are not release evidence. The catalog entries remain with `audioAssetUrl`, `acoustic`, and `acousticEvidence` unset. Existing Atlas records are not changed automatically; apply the updated seed only to a deliberately selected safe database.

## CC0 demo substitutions for fictional catalog entries

The following locally served MP3 files are licensed recordings used as explicitly documented **demo audio substitutes** for three fictional AstraDJ seed entries. They are not original recordings by the fictional catalog artists, and the displayed catalog titles/artists do not identify the source recordings. The audio substitutions must not be presented as the original songs.

| Catalog entry | Local asset | Actual source recording | Source duration |
| --- | --- | --- | ---: |
| `t_2001` · Night Drive | `city-lights-at-night-demo.mp3` | “City lights at night” | 190 s (3:10) |
| `t_2002` · Blue Horizon | `fresh-start-demo.mp3` | “Fresh start” | 120 s (2:00) |
| `t_2003` · Afterglow Avenue | `swaying-demo.mp3` | “Swaying” | 328 s (5:28) |

The recordings are from the Ondrosik Free Music Library. Its license page states that the collection was created by the site author and that all tracks are under CC0 1.0; attribution is welcomed but not required. The archive.org collection is the download mirror. Archive metadata duration and MD5 values were checked against the downloaded files before adding them; the SHA-256 values below identify the committed MP3 bytes.

- Creator/source and license statement: https://ondrosik.sk/music/
- CC0 1.0 legal code: https://creativecommons.org/publicdomain/zero/1.0/
- Archive collection: https://archive.org/details/Ondrosik-Free-music-catalog
- “City lights at night” source file: https://archive.org/download/Ondrosik-Free-music-catalog/City%20lights%20at%20night.mp3
  - Archive duration / MD5: `03:10` / `ff1f204b95432b3bb8b29b200d898200`
  - Local SHA-256: `47587641db646708facb4e636564ad0e4ff9970db86950c38425aad3b86b4b91`
- “Fresh start” source file: https://archive.org/download/Ondrosik-Free-music-catalog/Fresh%20start.mp3
  - Archive duration / MD5: `02:00` / `6476e0cbe13b3360bef2c4f6b152a987`
  - Local SHA-256: `1556db5af7e43e11649f9eac6ef1cc90d8b01b3c4124fdf5212d9a49f962a0bf`
- “Swaying” source file: https://archive.org/download/Ondrosik-Free-music-catalog/Swaying.mp3
  - Archive duration / MD5: `05:28` / `a64a7baa22b0de4db8157840c6ff0a2e`
  - Local SHA-256: `1bfdf9fb0cb4897d0ff6ab420d811e036ccd6bc3f4a3a54f088d6b8e3a32e220`

The seed duration for each mapped catalog item was updated to the source recording's rounded duration so player progress and completion checks use the served media duration. Titles, artists and timelines remain the fictional catalog copy and are not claims about the source recordings. The old profiles were not validated against these substitutes: the local seed now replaces Night Drive's profile with a signal-derived estimate tied to the City lights at night asset hash and leaves Blue Horizon and Afterglow Avenue acoustic profiles unavailable. The profile evidence and uncertainty are in `server/src/seed/tracks.js` and `docs/acoustic-profile-validation-2026-11-01.md`. This does not update any existing Atlas record.
