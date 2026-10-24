// Adapted detector graph/weight layout from transcribe.cpp v0.4.1 Silero code.
// Copyright (c) 2026 The transcribe.cpp authors. MIT; LICENSE.transcribe.
// Silero model protocol: Copyright (c) 2020-present Silero Team; ../silero-LICENSE.txt.
// No transcribe model/session private layouts: only public GGML/GGUF APIs.
#include "detector.h"
#include <ggml.h>
#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <gguf.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr int channels[] = {129, 128, 64, 64, 128};
constexpr int steps[] = {4, 4, 2, 1, 1};
constexpr int strides[] = {1, 2, 2, 1};
void require(bool value) { if (!value) throw std::runtime_error("invalid detector model or compute failure"); }
struct ContextDeleter { void operator()(ggml_context * p) const { if (p) ggml_free(p); } };
struct GgufDeleter { void operator()(gguf_context * p) const { if (p) gguf_free(p); } };
struct BufferDeleter { void operator()(ggml_backend_buffer * p) const { if (p) ggml_backend_buffer_free(p); } };
struct BackendDeleter { void operator()(ggml_backend * p) const { if (p) ggml_backend_free(p); } };
struct AllocDeleter { void operator()(ggml_gallocr * p) const { if (p) ggml_gallocr_free(p); } };
using Context = std::unique_ptr<ggml_context, ContextDeleter>;
using Buffer = std::unique_ptr<ggml_backend_buffer, BufferDeleter>;
using Backend = std::unique_ptr<ggml_backend, BackendDeleter>;
using Alloc = std::unique_ptr<ggml_gallocr, AllocDeleter>;
Context context(size_t tensors, size_t graph = 0) {
    ggml_init_params params{};
    params.no_alloc = true;
    params.mem_size = tensors * ggml_tensor_overhead() + graph;
    Context result(ggml_init(params));
    require(bool(result));
    return result;
}
std::vector<float> weight(ggml_context * ctx, const std::string & name, std::initializer_list<int64_t> shape) {
    auto * tensor = ggml_get_tensor(ctx, name.c_str());
    require(tensor && tensor->type == GGML_TYPE_F32 && ggml_is_contiguous(tensor));
    int dimension = 0;
    for (auto size : shape) require(tensor->ne[dimension++] == size);
    while (dimension < GGML_MAX_DIMS) require(tensor->ne[dimension++] == 1);
    const float * data = ggml_get_data_f32(tensor);
    require(data != nullptr);
    std::vector<float> values(data, data + ggml_nelements(tensor));
    for (float value : values) require(std::isfinite(value));
    return values;
}
void put(ggml_tensor * tensor, const std::vector<float> & data) {
    require(ggml_nbytes(tensor) == data.size() * sizeof(float));
    ggml_backend_tensor_set(tensor, data.data(), 0, data.size() * sizeof(float));
}
float sigmoid(float value) { return 1.0f / (1.0f + std::exp(-value)); }
}

struct tx_vad {
    Backend backend;
    Context weights_context;
    Buffer weights_buffer;
    ggml_tensor * basis = nullptr;
    ggml_tensor * dense[4]{};
    ggml_tensor * bias[4]{};
    ggml_tensor * input_weight = nullptr;
    ggml_tensor * input_bias = nullptr;
    std::vector<float> recurrent, head;
    float head_bias = 0;

    tx_vad(const void * bytes, size_t size) {
        require(bytes && size == 1241056); // Only the pinned F32 model format.
        ggml_context * raw = nullptr;
        gguf_init_params params{};
        params.no_alloc = false;
        params.ctx = &raw;
        std::unique_ptr<gguf_context, GgufDeleter> file(gguf_init_from_buffer(bytes, size, params));
        Context loaded(raw);
        require(file && loaded && gguf_get_n_tensors(file.get()) == 15);
        auto original_basis = weight(loaded.get(), "frontend.stft_basis", {256, 258});
        std::vector<float> conv[4], conv_bias[4];
        for (int i = 0; i < 4; ++i) {
            conv[i] = weight(loaded.get(), "enc." + std::to_string(i) + ".conv.weight", {3, channels[i], channels[i+1]});
            conv_bias[i] = weight(loaded.get(), "enc." + std::to_string(i) + ".conv.bias", {channels[i+1]});
        }
        auto input = weight(loaded.get(), "lstm.weight_ih", {128, 512});
        auto rec = weight(loaded.get(), "lstm.weight_hh", {128, 512});
        auto combined_bias = weight(loaded.get(), "lstm.bias_ih", {512});
        auto rec_bias = weight(loaded.get(), "lstm.bias_hh", {512});
        head = weight(loaded.get(), "head.weight", {128});
        head_bias = weight(loaded.get(), "head.bias", {1})[0];
        for (int i = 0; i < 512; ++i) combined_bias[i] += rec_bias[i];
        recurrent.resize(128 * 512);
        for (int j = 0; j < 128; ++j)
            for (int g = 0; g < 512; ++g) recurrent[j*512+g] = rec[g*128+j];
        backend.reset(ggml_backend_cpu_init());
        require(bool(backend));
        ggml_backend_cpu_set_n_threads(backend.get(), 1);
        weights_context = context(12);
        basis = ggml_new_tensor_2d(weights_context.get(), GGML_TYPE_F32, 256, 272);
        for (int i = 0; i < 4; ++i) {
            int in = steps[i] * (i == 0 ? 136 : channels[i]);
            int out = steps[i+1] * channels[i+1];
            dense[i] = ggml_new_tensor_2d(weights_context.get(), GGML_TYPE_F32, in, out);
            bias[i] = ggml_new_tensor_1d(weights_context.get(), GGML_TYPE_F32, out);
        }
        input_weight = ggml_new_tensor_2d(weights_context.get(), GGML_TYPE_F32, 128, 512);
        input_bias = ggml_new_tensor_1d(weights_context.get(), GGML_TYPE_F32, 512);
        weights_buffer.reset(ggml_backend_alloc_ctx_tensors(weights_context.get(), backend.get()));
        require(bool(weights_buffer));
        ggml_backend_buffer_set_usage(weights_buffer.get(), GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        std::vector<float> padded_basis(256*272, 0);
        for (int half = 0; half < 2; ++half)
            for (int bin = 0; bin < 129; ++bin)
                std::copy_n(original_basis.data()+(half*129+bin)*256,256,padded_basis.data()+(half*136+bin)*256);
        put(basis, padded_basis);
        for (int i = 0; i < 4; ++i) {
            int icp = i == 0 ? 136 : channels[i];
            int width = steps[i] * icp;
            std::vector<float> matrix(width * steps[i+1] * channels[i+1], 0);
            std::vector<float> biases(steps[i+1]*channels[i+1]);
            for (int to = 0; to < steps[i+1]; ++to) {
                for (int oc = 0; oc < channels[i+1]; ++oc) {
                    for (int k = 0; k < 3; ++k) {
                        int ti = to*strides[i]+k-1;
                        if (ti < 0 || ti >= steps[i]) continue;
                        for (int ic = 0; ic < channels[i]; ++ic)
                            matrix[(to*channels[i+1]+oc)*width+ti*icp+ic] = conv[i][(oc*channels[i]+ic)*3+k];
                    }
                    biases[to*channels[i+1]+oc] = conv_bias[i][oc];
                }
            }
            put(dense[i], matrix); put(bias[i], biases);
        }
        put(input_weight, input); put(input_bias, combined_bias);
    }

    std::vector<float> encode(const std::vector<float> & windows, int frames) {
        constexpr int graph_size = 64;
        auto ctx = context(graph_size, ggml_graph_overhead_custom(graph_size, false));
        auto * source = ggml_new_tensor_2d(ctx.get(), GGML_TYPE_F32, 256, 4*frames);
        ggml_set_input(source);
        auto * spectrum = ggml_mul_mat(ctx.get(), basis, source);
        auto * real = ggml_view_2d(ctx.get(), spectrum, 136, spectrum->ne[1], spectrum->nb[1], 0);
        auto * imaginary = ggml_view_2d(ctx.get(), spectrum, 136, spectrum->ne[1], spectrum->nb[1], 136 * ggml_element_size(spectrum));
        auto * magnitude = ggml_sqrt(ctx.get(), ggml_add(ctx.get(), ggml_sqr(ctx.get(), real), ggml_sqr(ctx.get(), imaginary)));
        auto * x = ggml_reshape_2d(ctx.get(), magnitude, 136*4, frames);
        for (int i = 0; i < 4; ++i)
            x = ggml_relu(ctx.get(), ggml_add(ctx.get(), ggml_mul_mat(ctx.get(), dense[i], x), bias[i]));
        auto * gates = ggml_add(ctx.get(), ggml_mul_mat(ctx.get(), input_weight, x), input_bias);
        ggml_set_output(gates);
        auto * graph = ggml_new_graph_custom(ctx.get(), graph_size, false);
        ggml_build_forward_expand(graph, gates);
        Alloc allocation(ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend.get())));
        require(bool(allocation) && ggml_gallocr_alloc_graph(allocation.get(), graph));
        put(source, windows);
        require(ggml_backend_graph_compute(backend.get(), graph) == GGML_STATUS_SUCCESS);
        std::vector<float> result(512*frames);
        ggml_backend_tensor_get(gates, result.data(), 0, result.size()*sizeof(float));
        return result;
    }

    void score(const float * audio, size_t count, float * probabilities) {
        std::array<float,64> context{};
        std::array<float,128> hidden{}, cell{};
        const size_t total = (count+511)/512;
        for (size_t first = 0; first < total; first += 256) {
            int real_frames = static_cast<int>(std::min<size_t>(256, total-first));
            int frames = std::max(4, real_frames);
            std::vector<float> windows(frames*4*256,0);
            for (int f = 0; f < real_frames; ++f) {
                std::array<float,640> buffer{};
                std::copy(context.begin(),context.end(),buffer.begin());
                size_t offset = (first+f)*512;
                std::copy_n(audio+offset,std::min<size_t>(512,count-offset),buffer.begin()+64);
                for (int j = 0; j < 64; ++j) buffer[576+j] = buffer[574-j];
                for (int t = 0; t < 4; ++t)
                    std::copy_n(buffer.begin()+t*128,256,windows.begin()+(f*4+t)*256);
                std::copy_n(buffer.begin()+512,64,context.begin());
            }
            auto input = encode(windows,frames);
            for (int f = 0; f < real_frames; ++f) {
                std::array<float,512> gates{};
                // Keep the upstream reduction order (one hidden component at a time).
                for (int g = 0; g < 512; ++g) gates[g] = input[f*512+g];
                for (int j = 0; j < 128; ++j)
                    for (int g = 0; g < 512; ++g) gates[g] += recurrent[j*512+g]*hidden[j];
                float logit = 0;
                for (int j = 0; j < 128; ++j) {
                    cell[j] = sigmoid(gates[128+j])*cell[j] + sigmoid(gates[j])*std::tanh(gates[256+j]);
                    hidden[j] = sigmoid(gates[384+j])*std::tanh(cell[j]);
                    logit += head[j]*std::max(hidden[j],0.0f);
                }
                float probability = sigmoid(logit+head_bias);
                require(std::isfinite(probability) && probability >= 0 && probability <= 1);
                probabilities[first+f] = probability;
            }
        }
    }
};
extern "C" int tx_vad_open(const void * bytes, size_t size, tx_vad ** out) {
    if (!out) return 1;
    *out = nullptr;
    try { *out = new tx_vad(bytes,size); return 0; } catch (...) { return 1; }
}
extern "C" void tx_vad_close(tx_vad * detector) { delete detector; }
extern "C" int tx_vad_score(tx_vad * detector, const float * audio, size_t count, float * out, size_t capacity) {
    if (!detector || !audio || !out || !count || count > 16000*300 || capacity < (count+511)/512) return 1;
    for (size_t i = 0; i < count; ++i) if (!std::isfinite(audio[i]) || std::abs(audio[i]) > 1) return 1;
    try { detector->score(audio,count,out); return 0; } catch (...) { return 1; }
}
