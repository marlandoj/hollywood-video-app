# Measured sound finishing

In **Edit sound session → Loudness and delivery master**, owners can leave the mix unchanged, measure it, or review normalization and peak limiting. The default leaves existing media processing unchanged. A continued session inherits its finishing settings; turning them off creates another version using the original mix. Selection and rollback use the existing retained-export history.

Normalization accepts a full-program target from −30 to −9 LUFS, a true-peak ceiling from −9 to −1 dBTP and a range target from 1 to 20 LU, in 0.1 steps. The initial values are −23 LUFS, −2 dBTP and 7 LU. These are editable processing settings, not named broadcast certifications. Source mixes and individual stems must already fit 24-bit PCM; mastering cannot recover an overloaded stem. Requested gain above 20 dB, silence, audio below the gate and material shorter than three seconds refuse normalization with an actionable message. Measurement remains available for those sources.

## Measurements and processing

The worker measures the complete stereo source mix, delivery WAV and decoded AAC track over the exact retained picture duration. Each measurement retains integrated loudness, true peak, relative gating threshold and loudness range from FFmpeg's first-pass `loudnorm` input statistics. `ebur128` also retains 100 ms metadata windows and completed-window momentary and short-term maxima. No speech detector or dialogue gate is substituted for full-program measurement.

The raw JSON statistics and window text accompany the summarized report. Silence has null loudness and peak values. A non-silent signal below the integrated gate keeps its measurable peak. Incomplete 400 ms and three-second windows cannot establish their respective readings. Range is marked unstable for material under 60 seconds. Some FFmpeg builds emit NaN momentary/short-term values around quiet windows; these stay in the raw text, become unavailable counts, and are excluded from reported maxima. The UI explicitly identifies those counts. Invalid integrated/peak statistics fail processing; they are never replaced with a claimed result.

Two-pass `loudnorm` receives its measured input loudness, peak, range, threshold and offset. It applies linear gain when its implementation permits, otherwise dynamic normalization and limiting. The actual reported mode and exact filter string are retained. Notably, FFmpeg 8.0.1 also falls back to dynamic mode when measured range equals zero; the receipt never assumes that a requested linear mode was applied. Output is explicitly resampled to 48 kHz without dither, padded/trimmed to the admitted frame count, and retained as canonical stereo 24-bit WAV. The encoded picture and caption bytes stay unchanged.

WAV and AAC target outcomes are reported separately using ±0.2 LU integrated tolerance and a 0.05 dB meter rounding allowance at the ceiling. These outcomes only assess the chosen integrated/peak settings. They do not establish range compliance, codec-chain compliance, listening quality, or broadcast certification. An unmet target remains visible for owner review; the application does not silently claim success or keep changing the processing until an arbitrary target is reached.

## Independent source and delivery records

All seven existing stems remain before master processing. `stems/mix.wav` is the untouched mix; `finishing/master.wav` is the separately processed delivery waveform. Dynamic mastering is nonlinear, so summing the pre-master stems does not reconstruct the processed master. The WAV master and JSON report have private owned download URLs. MP4 and HLS use the master. Each version still carries original voice performances, recording rights, cue sheet and provider invoices.

Finishing uses `hv-sound-finishing/1` settings inside version-2 sound sessions and result reports. Existing version-1 sessions and reports remain readable; absent settings preserve their original contract. State schema 3 and existing owned-file inventories carry the additional artifacts through PostgreSQL/S3 checkpoints and independent archives. Current permissions and the worker fence are checked throughout the subprocess work. There is no provider dispatch or charge.

Recovery checks the original source, seven reproduced stems, master size/hash, raw statistics, processing recipe, downloadable report and encoded picture/captions. It remeasures the master and AAC, allowing 0.11 units for meter-version rounding, and reproduces the master exactly when the admitted FFmpeg runtime matches. With a different runtime, the retained original master and its receipts remain authoritative; the verifier does not replace it with a newer normalization. All finishing files remain subject to recording withdrawal and project retention.

## References and limits

[EBU Tech 3341 (2023)](https://tech.ebu.ch/docs/tech/tech3341.pdf) defines 400 ms momentary and three-second short-term windows, integrated gating, meter tolerances and range stabilization. [Tech 3342 (2023)](https://tech.ebu.ch/docs/tech/tech3342.pdf) defines the separate range algorithm. [R128 (2023)](https://tech.ebu.ch/docs/r/r128.pdf) describes programme normalization and associated distribution considerations. These references inform the labels and tests; the complete official meter qualification suite has not been passed here.

[FFmpeg filter documentation](https://github.com/FFmpeg/FFmpeg/blob/n8.0.1/doc/filters.texi) and [the pinned 8.0.1 implementation](https://github.com/FFmpeg/FFmpeg/blob/n8.0.1/libavfilter/af_loudnorm.c) describe processing and fallback behavior. The available flags are checked against the actual local binary; each job pins its runtime fingerprint.

[ATSC A/85:2026-07 Annex M](https://www.atsc.org/wp-content/uploads/2026/07/A85-2026-07-Annex-M.pdf) distinguishes dialogue-based long-form measurement from full-program short-form measurement. This release does not implement an ATSC dialogue-gated preset. Production listening, noise reduction, generated music/effects licensing, broader picture editing, interchange and Zo deployment remain open.
