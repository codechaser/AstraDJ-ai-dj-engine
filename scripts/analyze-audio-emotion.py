#!/usr/bin/env python3
"""Run the published MERT emotion ONNX model on a center 15-second Ogg segment.

Requires numpy, soundfile, scipy and onnxruntime. Supply an already downloaded
model file; this script never downloads weights or writes catalog profiles.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from scipy.signal import resample_poly

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True, type=Path, help='Path to mert_emotion_int8.onnx')
parser.add_argument('files', nargs='+', type=Path)
args = parser.parse_args()
options = ort.SessionOptions()
options.intra_op_num_threads = 4
session = ort.InferenceSession(str(args.model), sess_options=options, providers=['CPUExecutionProvider'])
input_name = session.get_inputs()[0].name
output_name = session.get_outputs()[0].name
for path in args.files:
    audio, sample_rate = sf.read(path, dtype='float32', always_2d=True)
    mono = audio.mean(axis=1)
    if sample_rate != 24000:
        mono = resample_poly(mono, 24000, sample_rate).astype(np.float32)
    duration = len(mono) / 24000
    start = max(0, int(((duration - 15) / 2) * 24000))
    segment = mono[start:start + 360000]
    if len(segment) < 360000:
        segment = np.pad(segment, (0, 360000 - len(segment)))
    prediction = session.run([output_name], {input_name: segment[None, :].astype(np.float32)})[0].reshape(-1)
    print(json.dumps({
        'file': path.name,
        'model': 'huyleit/mert-v1-95m-music-emotion-int8',
        'segment_start_seconds': start / 24000,
        'segment_duration_seconds': 15,
        'valence_model_estimate': float(prediction[0]),
        'arousal_model_estimate': float(prediction[1]),
        'arousal_is_used_as_energy_proxy': True,
    }))
