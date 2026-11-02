// Detector-only prototype using the existing runtime's public GGML API.
#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
struct tx_vad;
// Input is the verified pinned F32 GGUF, copied/owned before this call returns.
// Returns 0 on success, nonzero on invalid model/audio, allocation or compute error.
int tx_vad_open(const void * model_bytes, size_t size, struct tx_vad ** out);
void tx_vad_close(struct tx_vad * detector);
// Starts from zero recurrent/context state for each utterance. No normalization,
// thresholding or segmentation here. Caller owns ceil(samples/512) probabilities.
// Errors must never be interpreted as non-speech. Single caller per handle.
int tx_vad_score(struct tx_vad * detector, const float * audio, size_t samples,
                 float * probabilities, size_t capacity);
#ifdef __cplusplus
}
#endif
