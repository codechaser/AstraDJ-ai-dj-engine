# Room sentiment evaluation

## Requirement and scope

The Internship PRD sets the sentiment accuracy KPI to **at least 85% against the project's own manually labeled positive/neutral/negative test set** (§1.3; DOCX extracted paragraph 51–52). It also requires a rolling-window scorer that buckets recent chat and produces a room score (§6.2; extracted paragraph 166). The PRD names no public corpus, sampling method, confidence interval, minimum set size, or multi-annotator procedure. The 85% KPI is a project benchmark, not evidence of real-world accuracy.

The classifier remains deterministic lexical/context rules; it is not ML and does not call an LLM. Labels are room-reaction labels: positive means clear enjoyment/approval or increased energy about the current session; negative means clear dislike/frustration/boredom or reduced energy; neutral means factual/request-only text, uncertainty, insufficient context, or no clearly dominant room reaction.

## Labeling guide

- Apply the message's meaning to the current room/music, not sentiment words mentioned as facts or descriptions of unrelated objects.
- Interpret explicit negation locally: “not bad” is positive; “not good” is negative; “not sure” is neutral. Do not infer polarity from `no` or `not` alone.
- For mixed or contrast messages, label the reaction to the current track when the target is clear. Otherwise use neutral. A balanced statement such as “not bad, not great” is neutral.
- Do not infer sarcasm from punctuation, emojis, or a positive word alone. Sarcasm requiring conversation context is neutral under this context-free protocol. This test does not measure contextual sarcasm reliably.
- Hinglish examples use common Latin transliteration. A message must still express a clear positive or negative reaction; language recognition alone is not a sentiment label.
- Short messages and typos receive a label only where intent remains clear (for example, repeated-letter emphasis or a recognizable spelling variation); otherwise neutral.
- Emoji-only or context-dependent messages are neutral unless their meaning is unambiguous within the text itself.

## Data origin and separation

All new messages are developer-authored synthetic examples. The `source` field on every example is `developer_authored_synthetic`; `caseType` records the intended linguistic challenge. No real-user messages were collected, and the data is not representative of actual Lounge traffic.

- **Development set:** `server/tests/fixtures/sentimentDevelopmentDataset.js`, 36 messages (12 per class). This was inspected to select focused rule changes for common Hinglish terms, repeated-letter spelling normalization, recognized spelling variants, and explicit short negative/positive phrases.
- **Frozen evaluation set:** `server/tests/fixtures/sentimentIndependentHeldoutDataset.js`, 90 messages (30 per class). The labels and examples were fixed before this increment's classifier changes. Its SHA-256 is `832b0f5ca1fbd62e67b293ddb09ecb33646c97b18cbc86201ec85f7a52519fcb`; a unit test guards that hash. The classifier was not tuned against these examples. The prior baseline and updated classifier were scored on this same set in a one-shot paired run.
- **Historical evaluation:** `server/tests/fixtures/sentimentHeldoutDataset.js` is the earlier 90-message synthetic set, previously used to inform rule changes. It remains historical/diagnostic and is not represented as an independent holdout in this milestone.
- **Lexicon-aware regression diagnostic:** `server/tests/fixtures/sentimentLabeledDataset.js` contains 40 messages authored after review of the original lexicon. Its 80% baseline and 90% current score are regression-only, not independent accuracy evidence.

## Results

`cd server && npm run benchmark:prd` reproduces all figures. Confusion matrices below use **actual rows and predicted columns** in the order positive, neutral, negative. Precision, recall and F1 are macro-independent per-class values rounded to four decimals.

### New frozen evaluation, n=90

| Model | Accuracy | Correct |
|---|---:|---:|
| Frozen pre-change classifier (same rules as at commit `fd8126e`) | 53.33% | 48/90 |
| Updated deterministic rules | 76.67% | 69/90 |

Baseline confusion matrix:

| Actual \\ Predicted | Positive | Neutral | Negative |
|---|---:|---:|---:|
| Positive | 14 | 16 | 0 |
| Neutral | 3 | 27 | 0 |
| Negative | 1 | 22 | 7 |

Updated confusion matrix:

| Actual \\ Predicted | Positive | Neutral | Negative |
|---|---:|---:|---:|
| Positive | 26 | 4 | 0 |
| Neutral | 5 | 25 | 0 |
| Negative | 1 | 11 | 18 |

| Updated class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| Positive | 0.8125 | 0.8667 | 0.8387 | 30 |
| Neutral | 0.6250 | 0.8333 | 0.7143 | 30 |
| Negative | 1.0000 | 0.6000 | 0.7500 | 30 |

Frozen-baseline per-class metrics:

| Baseline class | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| Positive | 0.7778 | 0.4667 | 0.5833 | 30 |
| Neutral | 0.4154 | 0.9000 | 0.5684 | 30 |
| Negative | 1.0000 | 0.2333 | 0.3784 | 30 |

Tagged challenge results on this set: ambiguous 3/5 (60%) and mixed 1/1 (100%). These subsets are too small for reliable category claims. The fixture contains multilingual transliteration, common music slang, local negation, contrast, short messages, and repeated-letter spelling variation. Context-dependent sarcasm is not meaningfully evaluated.

### Development and prior evaluations

- Development set: 20/36 (55.56%) before changes; 32/36 (88.89%) after development-guided rule changes. The development score is not a held-out result.
- Earlier, previously-used synthetic English set: 51/90 (56.67%) baseline and 68/90 (75.56%) after its earlier rule work. It is no longer independent and is shown by the benchmark only as historical evidence.
- Lexicon-aware 40-item regression diagnostic: 32/40 (80%) original lexical baseline; 36/40 (90%) current rules. This set is not independent.

## Interpretation and limitations

The new one-author synthetic holdout improved by 21/90 examples (23.33 percentage points) over the frozen prior classifier. The improvement is strongest for positive recall; neutral messages are sometimes overclassified positive, and negative recall remains 60%. The **PRD's 85% target was not reached** (76.67%). A balanced sample of 90 synthetic examples, authored/labeled by one developer, cannot establish production accuracy. Hinglish transliteration is narrow and dialect-sensitive; sarcasm, code-switching, emoji context, conversational history, and real room conditions need independently collected and multi-annotator-labeled evaluation. No real-user accuracy claim is supported.

The changes leave message event payloads, rolling aggregation, room isolation, and segue interfaces unchanged. Empty/ambiguous input continues to resolve conservatively to neutral when no lexical signal exists. Run the regression suite and benchmark with:

```sh
cd server
npm test -- --runInBand tests/roomSentiment.test.js
npm run benchmark:prd
```
