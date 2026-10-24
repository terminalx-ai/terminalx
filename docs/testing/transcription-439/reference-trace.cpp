// Diagnostic only. Public whisper.cpp API; explicit synthetic f32le inputs.
// Usage: reference-trace MODEL_BIN PROMPT_OR_EMPTY INPUT_F32LE...
#include <whisper.h>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>
int main(int argc, char **argv) {
    if (argc < 4) return 1;
    auto options = whisper_context_default_params();
    options.use_gpu = false;
    auto *model = whisper_init_from_file_with_params_no_state(argv[1], options);
    if (!model) return 2;
    bool failed = false;
    for (int i = 3; i < argc; ++i) {
        std::ifstream file(argv[i], std::ios::binary);
        std::vector<char> bytes((std::istreambuf_iterator<char>(file)), {});
        if (bytes.empty() || bytes.size() % 4 || bytes.size() > 16000 * 4 * 120) return 3;
        std::vector<float> pcm(bytes.size() / 4);
        std::memcpy(pcm.data(), bytes.data(), bytes.size());
        for (float sample : pcm) if (!std::isfinite(sample) || std::abs(sample) > 1) return 4;
        auto *state = whisper_init_state(model);
        if (!state) return 5;
        auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.n_threads = 2;
        params.no_timestamps = true;
        params.no_context = true;
        params.n_max_text_ctx = 224;
        params.language = "auto";
        params.greedy.best_of = 1;
        params.print_progress = false;
        params.print_realtime = false;
        params.print_timestamps = false;
        params.initial_prompt = argv[2][0] ? argv[2] : nullptr;
        int status = whisper_full_with_state(model, state, params, pcm.data(), static_cast<int>(pcm.size()));
        failed |= status != 0;
        int count = whisper_full_n_segments_from_state(state);
        std::string text;
        for (int segment = 0; segment < count; ++segment) text += whisper_full_get_segment_text_from_state(state, segment);
        std::cout << argv[i] << '\t' << status << '\t';
        const char *hex = "0123456789abcdef";
        for (unsigned char c : text) std::cout << hex[c >> 4] << hex[c & 15];
        std::cout << '\t' << count << '\n';
        for (int segment = 0; segment < count; ++segment)
            std::cout << "SEGMENT\t" << whisper_full_get_segment_t0_from_state(state, segment) * 10
                      << '\t' << whisper_full_get_segment_t1_from_state(state, segment) * 10
                      << '\t' << whisper_full_get_segment_no_speech_prob_from_state(state, segment) << '\n';
        whisper_free_state(state);
    }
    whisper_free(model);
    return failed ? 6 : 0;
}
