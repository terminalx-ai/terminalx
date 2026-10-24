// Diagnostic only: public transcribe-cpp C API, no private layouts.
// Usage: whisper-trace MODEL_GGUF PROMPT_OR_EMPTY INPUT_F32LE...
#include <transcribe.h>
#include <transcribe/whisper.h>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>

int main(int argc, char **argv) {
    if (argc < 4) return 1;
    if (transcribe_init_backends_default() != TRANSCRIBE_OK) return 2;
    transcribe_model *model = nullptr;
    if (transcribe_model_load_file(argv[1], nullptr, &model) != TRANSCRIBE_OK) return 3;
    bool failed = false;
    for (int file = 3; file < argc; file++) {
        std::ifstream input(argv[file], std::ios::binary);
        std::vector<char> bytes((std::istreambuf_iterator<char>(input)), {});
        if (bytes.empty() || bytes.size() % 4 || bytes.size() > 16000 * 4 * 120) return 4;
        std::vector<float> pcm(bytes.size() / 4);
        std::memcpy(pcm.data(), bytes.data(), bytes.size());
        transcribe_session *session = nullptr;
        if (transcribe_session_init(model, nullptr, &session) != TRANSCRIBE_OK) return 5;
        transcribe_run_params params;
        transcribe_run_params_init(&params);
        transcribe_whisper_run_ext whisper;
        transcribe_whisper_run_ext_init(&whisper);
        if (argv[2][0]) {
            whisper.initial_prompt = argv[2];
            whisper.max_prev_context_tokens = 224;
            params.family = &whisper.ext;
        }
        auto status = transcribe_run(session, pcm.data(), static_cast<int>(pcm.size()), &params);
        failed |= status != TRANSCRIBE_OK;
        std::cout << argv[file] << '\t' << status << '\t';
        const char *text = transcribe_full_text(session);
        const char *hex = "0123456789abcdef";
        if (text) {
            for (const unsigned char *c = reinterpret_cast<const unsigned char *>(text); *c; c++) {
                std::cout << hex[*c >> 4] << hex[*c & 15];
            }
        }
        const int count = transcribe_get_whisper_chunk_count(session);
        std::cout << '\t' << count << '\n';
        for (int i = 0; i < count; i++) {
            transcribe_whisper_chunk_trace trace;
            transcribe_whisper_chunk_trace_init(&trace);
            if (transcribe_get_whisper_chunk_trace(session, i, &trace) != TRANSCRIBE_OK) return 6;
            std::cout << "TRACE\t" << trace.t0_ms << '\t' << trace.t1_ms << '\t'
                      << trace.no_speech_prob << '\t' << trace.avg_logprob << '\t'
                      << trace.no_speech_triggered << '\n';
        }
        transcribe_session_free(session);
    }
    transcribe_model_free(model);
    return failed ? 7 : 0;
}
