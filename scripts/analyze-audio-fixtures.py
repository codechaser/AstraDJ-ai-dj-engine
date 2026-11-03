#!/usr/bin/env python3
"""Report reproducible signal features for AstraDJ's demo Ogg files.

Requires numpy, scipy, and soundfile. These estimates are diagnostic; this script
intentionally does not write acoustic profiles into MongoDB.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR_CAMELOT = dict(zip(NOTES, ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B']))
MINOR_CAMELOT = dict(zip(NOTES, ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A']))


def analyze(path: Path):
    raw, original_rate = sf.read(path, dtype='float32', always_2d=True)
    duration = len(raw) / original_rate
    mono = raw.mean(axis=1)
    rms_envelope_windows = []
    window_starts = sorted(set((
        0,
        max(0, duration * 0.25 - 15),
        max(0, duration * 0.5 - 15),
        max(0, duration * 0.75 - 15),
        max(0, duration - 30),
    )))
    for start in window_starts:
        segment = mono[int(start * original_rate):int(min(start + 30, duration) * original_rate)]
        rms_envelope_windows.append({
            'start_seconds': round(start, 3),
            'duration_seconds': len(segment) / original_rate,
            'tempo_candidates': rms_envelope_tempo_candidates(segment, original_rate),
        })
    rate = 11025
    if original_rate != rate:
        mono = signal.resample_poly(mono, rate, original_rate)
    mono = mono.astype(np.float32)
    keys = []
    for fft_size in (8192, 16384):
        frequencies, _, spectrum = signal.stft(mono, fs=rate, nperseg=fft_size,
                                                noverlap=fft_size - 1024, boundary=None)
        magnitude = np.abs(spectrum)
        pitches = np.full(len(frequencies), -1, dtype=int)
        valid = frequencies > 20
        pitches[valid] = np.rint(69 + 12 * np.log2(frequencies[valid] / 440)).astype(int)
        chroma = np.zeros((12, magnitude.shape[1]))
        for pitch_class in range(12):
            chroma[pitch_class] = magnitude[(pitches >= 0) & (pitches % 12 == pitch_class)].sum(axis=0)
        chroma /= np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-12
        profile = chroma.mean(axis=1)
        candidates = []
        for shift, note in enumerate(NOTES):
            for mode, template, mapping in (('major', MAJOR, MAJOR_CAMELOT), ('minor', MINOR, MINOR_CAMELOT)):
                score = float(np.corrcoef(profile, np.roll(template, shift))[0, 1])
                candidates.append({'key': f'{note} {mode}', 'camelot': mapping[note], 'correlation': score})
        candidates.sort(key=lambda item: item['correlation'], reverse=True)
        keys.append({'fft_size': fft_size, 'top_candidates': candidates[:5],
                     'top_margin': candidates[0]['correlation'] - candidates[1]['correlation']})

    hop = 256
    frequencies, _, spectrum = signal.stft(mono, fs=rate, nperseg=4096,
                                            noverlap=4096 - hop, boundary=None)
    magnitude = np.abs(spectrum)
    flux = np.maximum(0, np.diff(np.log1p(magnitude * 1000), axis=1)).sum(axis=0)
    flux = signal.detrend(flux)
    flux -= flux.mean()
    autocorrelation = signal.correlate(flux, flux, mode='full', method='fft')[len(flux) - 1:]
    autocorrelation /= autocorrelation[0] + 1e-12
    tempos = []
    min_lag = round(60 * rate / (hop * 220))
    max_lag = round(60 * rate / (hop * 55))
    for lag in range(min_lag, min(max_lag, len(autocorrelation) - 1)):
        if autocorrelation[lag] >= autocorrelation[lag - 1] and autocorrelation[lag] >= autocorrelation[lag + 1]:
            tempos.append({'bpm': float(60 * rate / (hop * lag)), 'autocorrelation': float(autocorrelation[lag])})
    tempos.sort(key=lambda item: item['autocorrelation'], reverse=True)
    return {
        'file': path.name, 'bytes': path.stat().st_size,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'format': sf.info(path).format, 'subtype': sf.info(path).subtype,
        'sample_rate_hz': original_rate, 'channels': sf.info(path).channels,
        'frames': sf.info(path).frames, 'duration_seconds': duration,
        'rms_float32': float(np.sqrt(np.mean(mono * mono))),
        'peak_float32': float(np.max(np.abs(mono))),
        'key_candidates': keys, 'tempo_candidates': tempos[:8],
        'rms_envelope_tempo_windows': rms_envelope_windows,
        'method': 'stereo mean to mono; resample_poly to 11025 Hz; STFT magnitude chroma vs Krumhansl-Schmuckler templates at 8192/16384 FFT; positive spectral-flux autocorrelation for tempo candidates; independent high-pass RMS-envelope autocorrelation in up to five 30-second windows',
    }


def rms_envelope_tempo_candidates(mono: np.ndarray, sample_rate: int):
    """Independent tempo cross-check using high-pass RMS-envelope novelty.

    The 30-second segment is resampled to 22,050 Hz, high-pass filtered with a
    fourth-order 100 Hz Butterworth filter, and analyzed in 20 ms RMS frames at
    5 ms hops. Positive RMS changes are autocorrelated over 55–220 BPM. These
    are candidate pulses, not ground-truth tempo labels.
    """
    target_rate = 22050
    if sample_rate != target_rate:
        mono = signal.resample_poly(mono, target_rate, sample_rate).astype(np.float32)
        sample_rate = target_rate
    filtered = signal.sosfilt(signal.butter(4, 100, fs=sample_rate, btype='highpass', output='sos'), mono)
    frame_length = 440
    hop = 110
    if len(filtered) < frame_length * 4:
        return []
    frames = np.lib.stride_tricks.sliding_window_view(filtered, frame_length)[::hop]
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    novelty = np.maximum(0, np.diff(rms, prepend=rms[0]))
    novelty = signal.detrend(novelty)
    novelty -= novelty.mean()
    autocorrelation = signal.correlate(novelty, novelty, mode='full', method='fft')[len(novelty) - 1:]
    autocorrelation /= autocorrelation[0] + 1e-12
    frames_per_second = sample_rate / hop
    min_lag = round(frames_per_second * 60 / 220)
    max_lag = round(frames_per_second * 60 / 55)
    peaks = []
    for lag in range(max(min_lag, 1), min(max_lag, len(autocorrelation) - 1)):
        if autocorrelation[lag] >= autocorrelation[lag - 1] and autocorrelation[lag] >= autocorrelation[lag + 1]:
            peaks.append({
                'bpm': float(60 * frames_per_second / lag),
                'autocorrelation': float(autocorrelation[lag]),
            })
    peaks.sort(key=lambda item: item['autocorrelation'], reverse=True)
    return peaks[:4]


def main():
    root = Path(__file__).resolve().parents[1]
    default_files = [root / 'public/audio/thoughtness.ogg', root / 'public/audio/chill-beat.ogg']
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='*', type=Path, default=default_files)
    args = parser.parse_args()
    for audio_path in args.files:
        print(json.dumps(analyze(audio_path), indent=2))


if __name__ == '__main__':
    main()
