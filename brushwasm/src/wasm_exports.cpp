#include "brush_engine.h"
#include <emscripten.h>
#include <unordered_map>
#include <cstdlib>

// ── インスタンスレジストリ ─────────────────────────────────────────────────────
// JS 側は整数 ID でエンジンを参照し、C++ 側でポインタにマップする。
// TS の GC が管理できないヒープオブジェクトを安全に扱うための設計。
static std::unordered_map<int, BrushEngine*> g_engines;
static std::unordered_map<int, BrushCfg*>    g_cfgs;
static int g_nextId = 1;

extern "C" {

// ── 一時ヒープ割り当て（カーブデータ転送用） ─────────────────────────────────
// JS から float 配列を Wasm ヒープに渡すために使う。
// TS 側は alloc_buf でポインタを取得し、データをコピーしてから brush_set_curve を呼ぶ。

EMSCRIPTEN_KEEPALIVE
void* alloc_buf(int bytes) { return std::malloc(bytes); }

EMSCRIPTEN_KEEPALIVE
void free_buf(void* ptr) { std::free(ptr); }

// ── ブラシのライフサイクル ────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
int brush_create(int type) {
    int id = g_nextId++;
    g_engines[id] = new BrushEngine();
    BrushCfg* cfg = new BrushCfg();
    cfg->type = static_cast<BrushType>(type);
    g_cfgs[id] = cfg;
    return id;
}

EMSCRIPTEN_KEEPALIVE
void brush_destroy(int id) {
    auto engineIt = g_engines.find(id);
    if (engineIt != g_engines.end()) { delete engineIt->second; g_engines.erase(engineIt); }
    auto cfgIt = g_cfgs.find(id);
    if (cfgIt != g_cfgs.end()) { delete cfgIt->second; g_cfgs.erase(cfgIt); }
}

// ── ブラシ設定 ────────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void brush_set_color(int id, float r, float g, float b) {
    auto it = g_cfgs.find(id);
    if (it == g_cfgs.end()) return;
    it->second->color[0] = r;
    it->second->color[1] = g;
    it->second->color[2] = b;
}

EMSCRIPTEN_KEEPALIVE
void brush_set_param(int id, int param, float value) {
    auto it = g_cfgs.find(id);
    if (it == g_cfgs.end()) return;
    BrushCfg* cfg = it->second;
    switch (static_cast<ParamId>(param)) {
        case ParamId::Size:    cfg->size    = value; break;
        case ParamId::Opacity: cfg->opacity = value; break;
        case ParamId::Density: cfg->density = value; break;
        case ParamId::Spacing: cfg->spacing = value; break;
        case ParamId::Mixing:  cfg->mixing  = value; break;
        case ParamId::Water:   cfg->water   = value; break;
        case ParamId::Spread:  cfg->spread  = value; break;
        default: break;
    }
}

EMSCRIPTEN_KEEPALIVE
void brush_set_curve(int id, int param, int modType, float* xs, float* ys, int n) {
    auto it = g_cfgs.find(id);
    if (it == g_cfgs.end()) return;
    if (param < 0 || param >= static_cast<int>(ParamId::COUNT)) return;
    auto& mod = it->second->mods[param];
    // modType: 0=筆圧カーブ, 1=速度カーブ
    auto& curve = (modType == 0) ? mod.pressure : mod.speed;
    curve.clear();
    for (int i = 0; i < n; i++) curve.push_back({xs[i], ys[i]});
}

EMSCRIPTEN_KEEPALIVE
void brush_set_random(int id, int param, float amount) {
    auto it = g_cfgs.find(id);
    if (it == g_cfgs.end()) return;
    if (param < 0 || param >= static_cast<int>(ParamId::COUNT)) return;
    it->second->mods[param].random = amount;
}

EMSCRIPTEN_KEEPALIVE
void brush_set_type(int id, int type) {
    auto it = g_cfgs.find(id);
    if (it != g_cfgs.end()) it->second->type = static_cast<BrushType>(type);
}

EMSCRIPTEN_KEEPALIVE
void brush_set_hardness(int id, float hardness) {
    auto it = g_cfgs.find(id);
    if (it != g_cfgs.end()) it->second->hardness = hardness;
}

EMSCRIPTEN_KEEPALIVE
void brush_set_eraser(int id, int eraser) {
    auto it = g_cfgs.find(id);
    if (it != g_cfgs.end()) it->second->eraser = eraser != 0;
}

// ── キャンバスバッファ ────────────────────────────────────────────────────────
// ストローク開始前に TS 側がここに現在のキャンバスをコピーし、
// strokeTo 後に同じポインタからピクセルデータを読み返す。
// リサイズ時のみ内部バッファが再確保される。

EMSCRIPTEN_KEEPALIVE
uint8_t* brush_get_canvas_buf(int id, int cw, int ch) {
    auto engineIt = g_engines.find(id);
    if (engineIt == g_engines.end()) return nullptr;
    return engineIt->second->getCanvasBuf(cw, ch);
}

EMSCRIPTEN_KEEPALIVE
int brush_canvas_w(int id) {
    auto engineIt = g_engines.find(id);
    if (engineIt == g_engines.end()) return 0;
    return engineIt->second->canvasW();
}

EMSCRIPTEN_KEEPALIVE
int brush_canvas_h(int id) {
    auto engineIt = g_engines.find(id);
    if (engineIt == g_engines.end()) return 0;
    return engineIt->second->canvasH();
}

// ── ストローク ────────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void brush_begin_stroke(int id, float x, float y, float pressure, float speed) {
    auto engineIt = g_engines.find(id);
    auto cfgIt    = g_cfgs.find(id);
    if (engineIt == g_engines.end() || cfgIt == g_cfgs.end()) return;
    engineIt->second->beginStroke(x, y, pressure, speed, *cfgIt->second);
}

EMSCRIPTEN_KEEPALIVE
void brush_stroke_to(int id, float x, float y, float pressure, float speed) {
    auto engineIt = g_engines.find(id);
    auto cfgIt    = g_cfgs.find(id);
    if (engineIt == g_engines.end() || cfgIt == g_cfgs.end()) return;
    engineIt->second->strokeTo(x, y, pressure, speed, *cfgIt->second);
}

} // extern "C"
