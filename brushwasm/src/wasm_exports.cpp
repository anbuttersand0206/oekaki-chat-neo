#include "brush_engine.h"
#include <emscripten.h>
#include <unordered_map>
#include <cstdlib>

// ── Instance registry ─────────────────────────────────────────────────────────
static std::unordered_map<int, BrushEngine*> g_engines;
static std::unordered_map<int, BrushCfg*>    g_cfgs;
static int g_next_id = 1;

extern "C" {

// ── Temporary heap allocation (for curve data transfer) ───────────────────────

EMSCRIPTEN_KEEPALIVE
void* alloc_buf(int bytes) { return std::malloc(bytes); }

EMSCRIPTEN_KEEPALIVE
void free_buf(void* ptr) { std::free(ptr); }

// ── Brush lifecycle ───────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
int brush_create(int type) {
    int id = g_next_id++;
    g_engines[id] = new BrushEngine();
    BrushCfg* cfg = new BrushCfg();
    cfg->type = static_cast<BrushType>(type);
    g_cfgs[id] = cfg;
    return id;
}

EMSCRIPTEN_KEEPALIVE
void brush_destroy(int id) {
    auto ei = g_engines.find(id);
    if (ei != g_engines.end()) { delete ei->second; g_engines.erase(ei); }
    auto ci = g_cfgs.find(id);
    if (ci != g_cfgs.end()) { delete ci->second; g_cfgs.erase(ci); }
}

// ── Configuration ─────────────────────────────────────────────────────────────

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
    BrushCfg* c = it->second;
    switch (static_cast<ParamId>(param)) {
        case ParamId::Size:    c->size    = value; break;
        case ParamId::Opacity: c->opacity = value; break;
        case ParamId::Density: c->density = value; break;
        case ParamId::Spacing: c->spacing = value; break;
        case ParamId::Mixing:  c->mixing  = value; break;
        case ParamId::Water:   c->water   = value; break;
        case ParamId::Spread:  c->spread  = value; break;
        default: break;
    }
}

EMSCRIPTEN_KEEPALIVE
void brush_set_curve(int id, int param, int mod_type, float* xs, float* ys, int n) {
    auto it = g_cfgs.find(id);
    if (it == g_cfgs.end()) return;
    if (param < 0 || param >= static_cast<int>(ParamId::COUNT)) return;
    auto& mod = it->second->mods[param];
    auto& cv  = (mod_type == 0) ? mod.pressure : mod.speed;
    cv.clear();
    for (int i = 0; i < n; i++) cv.push_back({xs[i], ys[i]});
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

// ── Canvas buffer ─────────────────────────────────────────────────────────────
// Call this once per canvas resize to get the internal RGBA buffer pointer.
// TS must copy canvas pixels INTO this buffer before calling brush_begin_stroke,
// then read them back after brush_stroke_to.
EMSCRIPTEN_KEEPALIVE
uint8_t* brush_get_canvas_buf(int id, int cw, int ch) {
    auto ei = g_engines.find(id);
    if (ei == g_engines.end()) return nullptr;
    return ei->second->getCanvasBuf(cw, ch);
}

EMSCRIPTEN_KEEPALIVE
int brush_canvas_w(int id) {
    auto ei = g_engines.find(id);
    if (ei == g_engines.end()) return 0;
    return ei->second->canvasW();
}

EMSCRIPTEN_KEEPALIVE
int brush_canvas_h(int id) {
    auto ei = g_engines.find(id);
    if (ei == g_engines.end()) return 0;
    return ei->second->canvasH();
}

// ── Stroke ────────────────────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
void brush_begin_stroke(int id, float x, float y, float pressure, float speed) {
    auto ei = g_engines.find(id);
    auto ci = g_cfgs.find(id);
    if (ei == g_engines.end() || ci == g_cfgs.end()) return;
    ei->second->beginStroke(x, y, pressure, speed, *ci->second);
}

EMSCRIPTEN_KEEPALIVE
void brush_stroke_to(int id, float x, float y, float pressure, float speed) {
    auto ei = g_engines.find(id);
    auto ci = g_cfgs.find(id);
    if (ei == g_engines.end() || ci == g_cfgs.end()) return;
    ei->second->strokeTo(x, y, pressure, speed, *ci->second);
}

} // extern "C"
