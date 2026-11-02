// Real pinned-model regression test for the public-GGML adapter. No audio files.
#include "detector.h"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <vector>

static void check(bool value) { if (!value) throw std::runtime_error("boundary assertion failed"); }
int main(int argc, char ** argv) {
    check(argc == 2);
    std::ifstream file(argv[1], std::ios::binary);
    check(bool(file));
    std::vector<char> model((std::istreambuf_iterator<char>(file)), {});
    tx_vad * detector = nullptr;
    check(tx_vad_open(nullptr, 0, &detector) != 0 && !detector);
    check(tx_vad_open(model.data(), model.size(), nullptr) != 0);
    check(tx_vad_open(model.data(), model.size(), &detector) == 0 && detector);
    // Cross both frame and 256-frame batch boundaries, including the short final
    // block which exposed the original imaginary-spectrum view offset defect.
    const size_t lengths[] = {1, 63, 64, 511, 512, 513, 2047, 2048, 2049,
                             255*512, 256*512, 256*512+1, 257*512, 260*512+1};
    for (size_t n : lengths) {
        std::vector<float> audio(n);
        for (size_t i = 0; i < n; ++i) audio[i] = .1f * std::sin(float(i) * .087f);
        size_t count = (n+511)/512;
        std::vector<float> first(count+2, -123), second(count+2, -123);
        check(tx_vad_score(detector, audio.data(), n, first.data()+1, count) == 0);
        // Perturb the handle with an unrelated utterance; the next call must
        // reset context/recurrent state, not depend on the preceding recording.
        float silence = 0, p = -123;
        check(tx_vad_score(detector, &silence, 1, &p, 1) == 0);
        check(tx_vad_score(detector, audio.data(), n, second.data()+1, count) == 0);
        check(first == second && first.front() == -123 && first.back() == -123);
        for (size_t i = 1; i <= count; ++i)
            check(std::isfinite(first[i]) && first[i] >= 0 && first[i] <= 1);
        check(tx_vad_score(detector, audio.data(), n, second.data()+1, count-1) != 0);
        check(first == second); // Rejected call must not write any output.
        std::cout << "PASS samples=" << n << " frames=" << count << '\n';
    }
    float audio = 0, out = -123;
    check(tx_vad_score(nullptr, &audio, 1, &out, 1) != 0);
    check(tx_vad_score(detector, nullptr, 1, &out, 1) != 0);
    check(tx_vad_score(detector, &audio, 1, nullptr, 1) != 0);
    check(tx_vad_score(detector, &audio, 0, &out, 1) != 0);
    check(tx_vad_score(detector, &audio, 16000*300+1, &out, 1) != 0);
    for (float bad : {std::numeric_limits<float>::quiet_NaN(),
                      std::numeric_limits<float>::infinity(),
                      -std::numeric_limits<float>::infinity(), 1.01f, -1.01f}) {
        check(tx_vad_score(detector, &bad, 1, &out, 1) != 0 && out == -123);
    }
    tx_vad_close(detector);
    tx_vad_close(nullptr);
    std::cout << "PASS invalid arguments, output bounds and utterance reset\n";
}
