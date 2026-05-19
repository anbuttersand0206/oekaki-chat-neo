#pragma once
#include <cstdint>
#include <vector>

// ── Brush types ──────────────────────────────────────────────────────────────
enum class BrushType : int {
    Pen=0, Marker=1, Pencil=2, Crayon=3, Airbrush=4,
    Watercolor=5, Oil=6, Pastel=7, Blur=8
};

enum class ParamId : int {
    Size=0, Opacity=1, Density=2, Spacing=3,
    Mixing=4, Water=5, Spread=6, COUNT=7
};

struct CurvePt { float x, y; };

struct ParamMod {
    std::vector<CurvePt> pressure; // multiplier curve vs pressure 0-1
    std::vector<CurvePt> speed;    // multiplier curve vs norm-speed 0-1
    float random = 0.f;
};

struct BrushCfg {
    BrushType type    = BrushType::Pen;
    float color[3]    = {0.f, 0.f, 0.f}; // RGB 0-255
    float size        = 20.f;
    float opacity     = 1.0f;
    float density     = 1.0f;
    float spacing     = 0.1f;
    float hardness    = 0.8f;  // 0=soft 1=hard
    float mixing      = 0.5f;
    float water       = 0.5f;
    float spread      = 0.3f;
    bool  eraser      = false;
    ParamMod mods[static_cast<int>(ParamId::COUNT)];
};

struct StrokeState {
    float prevX=0,prevY=0,prevP=0.5f,distAccum=0;
    float wetR=255,wetG=255,wetB=255; bool wetInit=false;
    uint64_t rng=0x5DEECE66DULL;
    float dirX=1,dirY=0;
};

// ── Engine ────────────────────────────────────────────────────────────────────
// Owns an internal RGBA canvas buffer.
// Usage:
//   1. ptr = getCanvasBuf(cw, ch)  — TS copies current canvas here
//   2. beginStroke(...)            — snapshots canvas, inits state
//   3. strokeTo(...)               — renders dabs into internal buffer
//   4. read back from ptr (same pointer as step 1)
class BrushEngine {
public:
    uint8_t* getCanvasBuf(int cw, int ch);
    int canvasW() const { return cw_; }
    int canvasH() const { return ch_; }

    void beginStroke(float x, float y, float pressure, float speed, const BrushCfg& cfg);
    void strokeTo   (float x, float y, float pressure, float speed, const BrushCfg& cfg);

private:
    StrokeState s_;
    std::vector<uint8_t> canvas_;    // live canvas (RGBA)
    std::vector<uint8_t> preStroke_; // snapshot at stroke start
    std::vector<float>   alphaBuf_;  // per-pixel max-alpha for this stroke
    int cw_=0, ch_=0;

    float rng();
    float evalCurve(const std::vector<CurvePt>& cv, float x) const;
    float resolve(ParamId pid, float base, float pressure, float speed, const BrushCfg& cfg);

    void dab(const BrushCfg&, float cx, float cy, float rad, float opa);

    void dabPen       (const BrushCfg&, float cx, float cy, float r, float a);
    void dabMarker    (const BrushCfg&, float cx, float cy, float r, float a);
    void dabPencil    (const BrushCfg&, float cx, float cy, float r, float a);
    void dabCrayon    (const BrushCfg&, float cx, float cy, float r, float a);
    void dabAirbrush  (const BrushCfg&, float cx, float cy, float r, float a);
    void dabWatercolor(const BrushCfg&, float cx, float cy, float r, float a);
    void dabOil       (const BrushCfg&, float cx, float cy, float r, float a);
    void dabPastel    (const BrushCfg&, float cx, float cy, float r, float a);
    void dabBlur      (const BrushCfg&, float cx, float cy, float r, float a);

    // Blend at canvas-global pixel (gx,gy) against current canvas
    void blendPx(int gx, int gy, float r, float g, float b, float alpha, bool eraser);
    // Max-alpha blend at (gx,gy) compositing against preStroke_ snapshot
    void blendPxBuf(int gx, int gy, float r, float g, float b, float alpha, bool eraser);

    float paperNoise(int gx, int gy) const;
    void  avgColor(float cx, float cy, float r, float& ar, float& ag, float& ab) const;
    void  avgColorFrom(const std::vector<uint8_t>& src, float cx, float cy, float r,
                       float& ar, float& ag, float& ab) const;

    static float softAlpha(float d, float hardness);
};
