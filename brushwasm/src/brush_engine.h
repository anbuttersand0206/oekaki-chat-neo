#pragma once
#include <cstdint>
#include <vector>

// ── ブラシ種別 ────────────────────────────────────────────────────────────────
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
    std::vector<CurvePt> pressure; // 筆圧 0-1 に対する乗数カーブ
    std::vector<CurvePt> speed;    // 正規化速度 0-1 に対する乗数カーブ
    float random = 0.f;
};

struct BrushCfg {
    BrushType type    = BrushType::Pen;
    float color[3]    = {0.f, 0.f, 0.f}; // RGB 0-255
    float size        = 20.f;
    float opacity     = 1.0f;
    float density     = 1.0f;
    float spacing     = 0.1f;
    float hardness    = 0.8f;  // 0=ソフト 1=ハード
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

// ── エンジン ──────────────────────────────────────────────────────────────────
// 内部に RGBA キャンバスバッファを持つ。
//
// 使用手順:
//   1. ptr = getCanvasBuf(cw, ch)  — TS がここに現在のキャンバスをコピーする
//   2. beginStroke(...)            — キャンバスをスナップショット、状態を初期化
//   3. strokeTo(...)               — ダブを内部バッファに描画
//   4. ptr（手順1と同じポインタ）からデータを読み返す
class BrushEngine {
public:
    uint8_t* getCanvasBuf(int cw, int ch);
    int canvasW() const { return cw_; }
    int canvasH() const { return ch_; }

    void beginStroke(float x, float y, float pressure, float speed, const BrushCfg& cfg);
    void strokeTo   (float x, float y, float pressure, float speed, const BrushCfg& cfg);

private:
    StrokeState s_;
    std::vector<uint8_t> canvas_;    // ライブキャンバス（RGBA）、常に合成済みの結果を保持
    std::vector<uint8_t> preStroke_; // ストローク開始時のスナップショット
    std::vector<uint8_t> strokeBuf_; // 蓄積ダブ（透明背景）、opa で合成
    std::vector<float>   alphaBuf_;  // ぼかしストロークのピクセルごと最大アルファ
    int cw_=0, ch_=0;

    float rng();
    float evalCurve(const std::vector<CurvePt>& cv, float x) const;
    float resolve(ParamId pid, float base, float pressure, float speed, const BrushCfg& cfg);

    // 単一ダブを描画する。flow=密度由来のダブアルファ、opa=ストローク不透明度
    void dab(const BrushCfg&, float cx, float cy, float rad, float flow, float opa);

    void dabPen       (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabMarker    (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabPencil    (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabCrayon    (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabAirbrush  (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabWatercolor(const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabOil       (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabPastel    (const BrushCfg&, float cx, float cy, float r, float flow, float opa);
    void dabBlur      (const BrushCfg&, float cx, float cy, float r, float flow);

    // canvas_ に直接アルファ制限付きでブレンドする（消しゴムはこちらを使う）
    void blendPx(int gx, int gy, float r, float g, float b, float alpha, float limit, bool eraser);
    // strokeBuf_ にブレンドし、preStroke_+strokeBuf_*opa を canvas_ に合成する
    void blendPxBuf(int gx, int gy, float r, float g, float b, float alpha, float opa);

    float paperNoise(int gx, int gy) const;
    void  avgColor(float cx, float cy, float r, float& ar, float& ag, float& ab) const;

    static float softAlpha(float d, float hardness);
};
