# Audio fixture analysis and evidence limits

This report documents four playable CC0 demo recordings in the catalog. The audio was analyzed locally; no credentials, production data, or application database was used. The analysis scripts report measurements but deliberately do not write profiles into MongoDB.

## Assets and licenses

| Track ID | Source | License | Stream metadata | SHA-256 |
|---|---|---|---|---|
| `t_cc0_thoughtness` | [Wikimedia Commons: Thoughtness.ogg](https://commons.wikimedia.org/wiki/File:Thoughtness.ogg), Kian Moretz | CC0 1.0 | Ogg/Vorbis, stereo, 44,100 Hz, 2,034,432 frames, 46.1322449 s | `f79dad2d56bc3be910d44724fde53dfb88be3d07315acb44aca70211a40cfe2c` |
| `t_cc0_chill_beat` | [Wikimedia Commons: Chill Beat.ogg](https://commons.wikimedia.org/wiki/File:Chill_Beat.ogg), Maddy (Coolgurl5555) | CC0 1.0 | Ogg/Vorbis, stereo, 44,100 Hz, 4,241,565 frames, 96.1806122 s | `0ebeaac7ed3e8fab0beb2a707d7e2eb048d673583d32d9dccba9a2be9f8e075b` |
| `t_cc0_ivory_atlas` | [Kaino source metadata](https://kaino.dev/api/library/music/creator-workout-01), “Ivory Atlas” | CC0 1.0 | MP3, stereo, 48,000 Hz, 8,640,000 frames, 180 s | `5c2babff71154b3640692804fcf4a928d2d5f15f09b7844891e0618b91cdee0b` |
| `t_cc0_faded_fortress` | [Kaino source metadata](https://kaino.dev/api/library/music/indie-rock-07), “Faded Fortress” | CC0 1.0 | MP3, stereo, 48,000 Hz, 5,760,000 frames, 120 s | `45ac8f72864df884dab654d6f50a34226ec8dab4402c00c74255a15db244e09a` |

Both Commons pages identify the uploader as the source and declare the recording under CC0. License and attribution records are also kept in `public/audio/NOTICE.md`.

## Reproduce signal analysis

The scripts use Python with `numpy`, `scipy`, and `soundfile`, installed outside the application runtime. Run:

```powershell
python -m pip install numpy scipy soundfile
python scripts/analyze-audio-fixtures.py
```

The script decodes the committed files, averages stereo to mono, resamples to 11,025 Hz, computes STFT chroma at 8,192- and 16,384-bin windows, correlates against Krumhansl-Schmuckler major/minor templates, and estimates tempo candidates using positive spectral flux autocorrelation. It prints checksums, format, sample count, duration, RMS and peak. These are reproducible candidate estimates, not ground-truth labels; key correlation margins and multiple tempo peaks are reported to expose ambiguity.

| Track | BPM candidates (strength) | Key candidates (correlation) | Finding |
|---|---|---|---|
| Thoughtness | 215.33 (.257), 58.73 (.250), 161.50 (.244), 80.75 (.227) | 8,192: A♯ major / 6B (.803), D♯ major / 5B (.744); 16,384: D♯ major / 5B (.793), A♯ major / 6B (.770) | Tempo has no clear leading pulse; leading key swaps by FFT size. BPM and Camelot key remain unverified. |
| Chill Beat | 58.73 (.874), 117.45 (.816); the first is a half-time relation to the second | E minor / 9A leads at both window sizes (.794 and .785); next is C major / 8B (.757 and .739) | A plausible 117.45 BPM double-time pulse and E minor/9A estimate are reproducible, but the close key alternatives do not establish a sufficiently certain Camelot key for hard matching. |
| Ivory Atlas | 69.84 (.739), 143.55 (.660) | A minor / 8A leads at both windows (.802/.783); margins over A major are .145/.134 | Kaino says 143 BPM, A minor. Signal pulse includes a strong half-time peak; source tempo is consistent. Source key and both chroma windows agree; relative-major uncertainty is disclosed. |
| Faded Fortress | 143.55 (.568), 71.78 (.563) | A minor / 8A leads at both windows (.800/.786); margins over A major are .038/.050 | Kaino says 142 BPM, A minor. Observed leading pulse is 1.1% from source. Key is source-backed and the same leading signal estimate at both windows, but the small margin means confidence is lower than Ivory Atlas. |

For the compatible pair, catalog profiles use the source-listed integer tempos (143 and 142 BPM) and source-listed A minor (8A), with the signal estimates retained as corroboration and uncertainty. MERT center-segment outputs supply valence estimates and an arousal-as-energy proxy; these are model estimates, not physical measurements. Values are not rounded to imply greater certainty: the seed stores the model output to ten decimal places and the provenance identifies the model/segment. The MERT ONNX model SHA-256 is `B05EF3FBE904F1121B32632DA9AD4907AFB676A11E348FE01484A71412C42E01`. Ivory Atlas outputs: valence .7740629911, arousal .8203068972 at 82.5 s. Faded Fortress: valence .6819971800, arousal .6857643127 at 52.5 s.

RMS is a digital signal level measurement, not a calibrated, cross-track perceived-energy value. For reference, it is 0.11086 for Thoughtness and 0.15443 for Chill Beat after the script's mono/resampling operation. Values depend on mastering and cannot be treated as comparable normalized energy scores without a defined calibration.

## Model-estimated valence and arousal

A separate offline inference used the Apache-2.0 model [huyleit/mert-v1-95m-music-emotion-int8](https://huggingface.co/huyleit/mert-v1-95m-music-emotion-int8). The downloaded ONNX weights had SHA-256 `B05EF3FBE904F1121B32632DA9AD4907AFB676A11E348FE01484A71412C42E01`. `scripts/analyze-audio-emotion.py` reproduces inference when given the model path. It resamples to 24 kHz mono and predicts on the center 15-second segment, as described by the model card.

| Track | Center segment start | Predicted valence | Predicted arousal (possible energy proxy) |
|---|---:|---:|---:|
| Thoughtness | 15.5661 s | 0.53601 | 0.51927 |
| Chill Beat | 40.5903 s | 0.43977 | 0.44549 |

These are model estimates, not measured ground truth. The model card reports its own held-out DEAM/PMEmo evaluation (386 tracks, valence MAE 0.0895 and arousal MAE 0.0861); AstraDJ has not independently evaluated this model on these demo tracks or established that its dataset performance transfers to this catalog. Inference on one center segment also does not characterize within-track variation. The model is an offline analysis tool only; no inference service was added to AstraDJ.

## Catalog and segue status

The catalog now contains two locally served audio assets, and `npm run test:e2e:catalog` checks Chill Beat's actual Ogg response, browser metadata, playback progress, and pause. Both tracks intentionally keep `acoustic: null`. The Track schema requires BPM, Camelot key, energy and valence together, while Thoughtness lacks reliable tempo/key evidence and Chill Beat's key has unresolved alternatives. No profile is written merely to make a candidate eligible. The matcher keeps its current BPM/Camelot hard constraints and 50/30/20 ranking unchanged.

The source-backed pair meets the current matcher rules: 143 vs 142 BPM is a 0.70% direct-tempo difference, both are 8A, and the existing 50/30/20 score is unchanged. The full provenance object is stored on each Track and returned by both catalog and acoustic-profile reads. Existing Wikimedia tracks remain unprofiled. Disposable-Mongo Chrome E2E loaded each MP3, read its metadata, played/paused the media, and exercised the playback-driven segue. At 10× playback, the browser reported 257.2 ms and 586.1 ms from the observed outro-window boundary to visible announcement across two independent test runs (P50 421.7 ms, nearest-rank P95/max 586.1 ms for n=2). The browser then observed natural media completion, the next asset played, and the durable Lounge current track plus `track.transitioned` event were verified. These two accelerated local observations are not a production P95 guarantee.
