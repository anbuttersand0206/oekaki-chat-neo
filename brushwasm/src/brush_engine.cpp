#include "brush_engine.h"
#include <cmath>
#include <cstring>
#include <algorithm>

// ── ユーティリティ ─────────────────────────────────────────────────────────────
static inline float clamp01(float v){ return v<0?0:v>1?1:v; }
static inline float lerpf(float a,float b,float t){ return a+(b-a)*t; }
static inline int   clampi(int v,int lo,int hi){ return v<lo?lo:v>hi?hi:v; }
static inline float sqrf(float x){ return x*x; }

// ── 乱数 / カーブ評価 ──────────────────────────────────────────────────────────
float BrushEngine::rng() {
    // PCG-like LCG: 32 ビット出力を -1～1 に変換する
    s_.rng = s_.rng * 6364136223846793005ULL + 1442695040888963407ULL;
    uint32_t r = (uint32_t)(s_.rng >> 33);
    return (float)(r & 0xFFFFFF) / (float)0xFFFFFF * 2.f - 1.f;
}

float BrushEngine::evalCurve(const std::vector<CurvePt>& cv, float x) const {
    if(cv.empty()) return 1.f;
    if(x <= cv.front().x) return cv.front().y;
    if(x >= cv.back().x)  return cv.back().y;
    for(size_t i=1;i<cv.size();i++){
        if(x <= cv[i].x){
            float t=(x-cv[i-1].x)/(cv[i].x-cv[i-1].x+1e-7f);
            return lerpf(cv[i-1].y,cv[i].y,t);
        }
    }
    return 1.f;
}

float BrushEngine::resolve(ParamId pid,float base,float pressure,float speed,const BrushCfg& cfg){
    const auto& m=cfg.mods[static_cast<int>(pid)];
    float mult=evalCurve(m.pressure,pressure)*evalCurve(m.speed,speed);
    if(m.random>1e-4f) mult*=(1.f+m.random*rng());
    return base*mult;
}

// ── softAlpha ─────────────────────────────────────────────────────────────────
// quintic smoothstep でエッジを滑らかにする。
// hardness=1 でハード円、0 で完全ソフト円になる。
float BrushEngine::softAlpha(float d, float hardness){
    if(d>=1.f) return 0.f;
    if(hardness>=1.f||d<=hardness) return 1.f;
    float t=(d-hardness)/(1.f-hardness+1e-7f);
    t=t*t*t*(t*(t*6.f-15.f)+10.f);
    return 1.f-t;
}

// ── ペーパーノイズ ─────────────────────────────────────────────────────────────
// 鉛筆・クレヨン・パステルの紙目テクスチャに使う整数ハッシュ。
// 2つの解像度をブレンドして粗さの表情を出している。
float BrushEngine::paperNoise(int cx,int cy) const {
    uint32_t h=(uint32_t)(cx*2654435761u)^(uint32_t)(cy*2246822519u);
    h^=h>>16; h*=0x45d9f3bu; h^=h>>16;
    uint32_t h2=(uint32_t)((cx/2)*2654435761u)^(uint32_t)((cy/2)*2246822519u);
    h2^=h2>>16; h2*=0x45d9f3bu; h2^=h2>>16;
    return (h&0xFF)/255.f*0.6f+(h2&0xFF)/255.f*0.4f;
}

// ── 平均色サンプリング ────────────────────────────────────────────────────────
// canvas_（常に合成済みの状態）から周辺色を平均する。
// ウェット系ブラシが既存の絵具を「拾う」ために使う。
void BrushEngine::avgColor(float cx,float cy,float r,float& ar,float& ag,float& ab) const {
    int sampleRadius=std::max(1,(int)(r*0.4f));
    int x0=clampi((int)(cx-sampleRadius),0,cw_-1), y0=clampi((int)(cy-sampleRadius),0,ch_-1);
    int x1=clampi((int)(cx+sampleRadius),0,cw_-1), y1=clampi((int)(cy+sampleRadius),0,ch_-1);
    float sumR=0,sumG=0,sumB=0; int cnt=0;
    for(int y=y0;y<=y1;y++) for(int x=x0;x<=x1;x++){
        int i=(y*cw_+x)*4;
        sumR+=canvas_[i]; sumG+=canvas_[i+1]; sumB+=canvas_[i+2]; cnt++;
    }
    if(cnt>0){ar=sumR/cnt;ag=sumG/cnt;ab=sumB/cnt;}
    else ar=ag=ab=255.f;
}

// ── キャンバスバッファ管理 ────────────────────────────────────────────────────
uint8_t* BrushEngine::getCanvasBuf(int cw,int ch){
    if(cw!=cw_||ch!=ch_){
        cw_=cw; ch_=ch;
        canvas_.assign(cw*ch*4,255);
        preStroke_.assign(cw*ch*4,255);
        strokeBuf_.assign(cw*ch*4,0);
        alphaBuf_.assign(cw*ch,0.f);
    }
    return canvas_.data();
}

// ── 直接ブレンド（消しゴム用） ───────────────────────────────────────────────
// canvas_ に直接書き込む。limit 引数はアルファ上限制御に使用（通常 1.0）。
// strokeBuf を通さないため、消しゴムのアルファが蓄積しない。
void BrushEngine::blendPx(int gx,int gy,float r,float g,float b,float alpha,float limit,bool eraser){
    if(gx<0||gy<0||gx>=cw_||gy>=ch_) return;
    if(alpha<=0.003f) return;
    alpha=clamp01(alpha);
    int idx=(gy*cw_+gx)*4;
    uint8_t* p=canvas_.data()+idx;
    if(eraser){
        float t=alpha;
        p[0]=(uint8_t)(p[0]+(255-p[0])*t);
        p[1]=(uint8_t)(p[1]+(255-p[1])*t);
        p[2]=(uint8_t)(p[2]+(255-p[2])*t);
        p[3]=(uint8_t)(p[3]+(255-p[3])*t);
        return;
    }
    float da=p[3]/255.f, sa=alpha;
    float outA=sa+da*(1.f-sa);
    if(outA > limit) outA = std::max(da, limit);
    if(outA<1e-5f){p[3]=0;return;}
    float inv=1.f/outA;
    p[0]=(uint8_t)((r*sa+p[0]*da*(1.f-sa))*inv);
    p[1]=(uint8_t)((g*sa+p[1]*da*(1.f-sa))*inv);
    p[2]=(uint8_t)((b*sa+p[2]*da*(1.f-sa))*inv);
    p[3]=(uint8_t)(outA*255.f);
}

// ── strokeBuf ブレンド + 合成（インクダブ全般） ───────────────────────────────
// (r,g,b,alpha) を strokeBuf_ に Porter-Duff over でブレンドし、
// preStroke_ + strokeBuf_*opa → canvas_ の合成を行う。
// opa をストロークレベルの不透明度として適用することで
// 複数ダブが重なっても蓄積しない「重ね塗り」が実現できる。
void BrushEngine::blendPxBuf(int gx,int gy,float r,float g,float b,float alpha,float opa){
    if(gx<0||gy<0||gx>=cw_||gy>=ch_) return;
    if(alpha<=0.003f) return;
    alpha=clamp01(alpha);
    int idx=(gy*cw_+gx)*4;

    // 1) strokeBuf_ に Porter-Duff over
    float sbDa=strokeBuf_[idx+3]/255.f, sa=alpha;
    float sbOut=sa+sbDa*(1.f-sa);
    if(sbOut<1e-5f) return;
    float inv=1.f/sbOut;
    strokeBuf_[idx]  =(uint8_t)((r  *sa+strokeBuf_[idx]  *sbDa*(1.f-sa))*inv);
    strokeBuf_[idx+1]=(uint8_t)((g  *sa+strokeBuf_[idx+1]*sbDa*(1.f-sa))*inv);
    strokeBuf_[idx+2]=(uint8_t)((b  *sa+strokeBuf_[idx+2]*sbDa*(1.f-sa))*inv);
    strokeBuf_[idx+3]=(uint8_t)(sbOut*255.f);

    // 2) preStroke_ + strokeBuf_*opa → canvas_ に合成
    float effA=sbOut*opa;
    float preA=preStroke_[idx+3]/255.f;
    float outA=effA+preA*(1.f-effA);
    uint8_t* p=canvas_.data()+idx;
    if(outA<1e-5f){p[3]=0;return;}
    float cinv=1.f/outA;
    p[0]=(uint8_t)((strokeBuf_[idx]  *effA+preStroke_[idx]  *preA*(1.f-effA))*cinv);
    p[1]=(uint8_t)((strokeBuf_[idx+1]*effA+preStroke_[idx+1]*preA*(1.f-effA))*cinv);
    p[2]=(uint8_t)((strokeBuf_[idx+2]*effA+preStroke_[idx+2]*preA*(1.f-effA))*cinv);
    p[3]=(uint8_t)(outA*255.f);
}

// ── N×N オーバーサンプリング円 ────────────────────────────────────────────────
// サブピクセル精度のアンチエイリアシングのため、各ピクセルを NxN グリッドに
// 分割してサンプリングする。半径が小さいほど N を大きくして精度を高める。
template<typename Fn>
static void iterCircleDab(float cx, float cy, float rad, float hardness, int cw, int ch, Fn fn) {
    const int   N        = rad<3.f?11:rad<15.f?5:3;
    const float invN     = 1.f/N;
    const float invNN    = 1.f/(N*N);
    const float rr       = rad*rad;
    const float innerR   = rad*hardness;
    const float innerRR  = innerR*innerR;
    const float edgeWidth = rad-innerR+1e-6f;
    int x0=clampi((int)(cx-rad),0,cw-1), y0=clampi((int)(cy-rad),0,ch-1);
    int x1=clampi((int)(cx+rad)+1,0,cw-1), y1=clampi((int)(cy+rad)+1,0,ch-1);
    for(int gy=y0;gy<=y1;gy++){
        for(int gx=x0;gx<=x1;gx++){
            float sum=0.f;
            for(int iy=0;iy<N;iy++){
                float py=gy+(iy+0.5f)*invN;
                float dy2=sqrf(py-cy);
                if(dy2>=rr) continue;
                for(int ix=0;ix<N;ix++){
                    float px=gx+(ix+0.5f)*invN;
                    float d2=sqrf(px-cx)+dy2;
                    if(d2>=rr) continue;
                    if(d2<=innerRR) sum+=1.f;
                    else { float s=clamp01((sqrtf(d2)-innerR)/edgeWidth); sum+=1.f-s*s*(3.f-2.f*s); }
                }
            }
            if(sum>0.f) fn(gx,gy,sum*invNN);
        }
    }
}

// ── ストロークインターフェース ────────────────────────────────────────────────
void BrushEngine::beginStroke(float x,float y,float pressure,float speed,const BrushCfg& cfg){
    s_.prevX=x; s_.prevY=y; s_.prevP=pressure;
    s_.distAccum=0; s_.wetInit=false;
    // ストローク開始時のキャンバスをスナップショットして合成の基準とする
    preStroke_=canvas_;
    std::fill(strokeBuf_.begin(),strokeBuf_.end(),(uint8_t)0);
    std::fill(alphaBuf_.begin(),alphaBuf_.end(),0.f);

    float ns=clamp01(speed/1000.f);
    float szRaw = std::max(0.01f, resolve(ParamId::Size, cfg.size, pressure, ns, cfg));
    float opa   = clamp01(resolve(ParamId::Opacity, cfg.opacity, pressure, ns, cfg));
    float den   = clamp01(resolve(ParamId::Density, cfg.density, pressure, ns, cfg));
    float flow  = den * (szRaw<1.f ? szRaw : 1.f);
    dab(cfg, x, y, std::max(1.f, szRaw)*0.5f, flow, opa);
}

void BrushEngine::strokeTo(float x,float y,float pressure,float speed,const BrushCfg& cfg){
    float dx=x-s_.prevX, dy=y-s_.prevY;
    float dist=sqrtf(dx*dx+dy*dy);
    if(dist<0.5f) return;
    s_.dirX=dx/dist; s_.dirY=dy/dist;
    float ns=clamp01(speed/1000.f);
    float szAtEnd = std::max(0.01f, resolve(ParamId::Size, cfg.size, pressure, ns, cfg));
    float spacing = std::max(1.f, std::max(0.01f, resolve(ParamId::Spacing, cfg.spacing, pressure, ns, cfg)) * szAtEnd);
    int stepCount=(int)ceilf(dist/spacing);
    float leftover=spacing-fmodf(s_.distAccum,spacing);
    float startFrac=leftover/dist;
    for(int i=0;i<stepCount;i++){
        float t=startFrac+(float)i/(float)stepCount*(1.f-startFrac);
        if(t>1.f) break;
        float cp=s_.prevP+(pressure-s_.prevP)*t;
        float szRaw = std::max(0.01f, resolve(ParamId::Size, cfg.size, cp, ns, cfg));
        float opa   = clamp01(resolve(ParamId::Opacity, cfg.opacity, cp, ns, cfg));
        float den   = clamp01(resolve(ParamId::Density, cfg.density, cp, ns, cfg));
        float flow  = den * (szRaw<1.f ? szRaw : 1.f);
        dab(cfg, s_.prevX+dx*t, s_.prevY+dy*t, std::max(1.f, szRaw)*0.5f, flow, opa);
    }
    s_.distAccum+=dist; s_.prevX=x; s_.prevY=y; s_.prevP=pressure;
}

void BrushEngine::dab(const BrushCfg& cfg,float cx,float cy,float rad,float flow,float opa){
    switch(cfg.type){
        case BrushType::Pen:        dabPen       (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Marker:     dabMarker    (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Pencil:     dabPencil    (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Crayon:     dabCrayon    (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Airbrush:   dabAirbrush  (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Watercolor: dabWatercolor(cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Oil:        dabOil       (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Pastel:     dabPastel    (cfg,cx,cy,rad,flow,opa); break;
        case BrushType::Blur:       dabBlur      (cfg,cx,cy,rad,flow*opa); break;
    }
}

// ── ブラシ種別の実装 ──────────────────────────────────────────────────────────
void BrushEngine::dabPen(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    iterCircleDab(cx,cy,rad,cfg.hardness,cw_,ch_,[&](int gx,int gy,float alpha){
        float a=alpha*flow; if(a<=0.003f) return;
        if(cfg.eraser) blendPx(gx,gy,0,0,0,a,1.f,true);
        else blendPxBuf(gx,gy,cfg.color[0],cfg.color[1],cfg.color[2],a,opa);
    });
}

void BrushEngine::dabMarker(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    iterCircleDab(cx,cy,rad,cfg.hardness,cw_,ch_,[&](int gx,int gy,float alpha){
        float a=alpha*flow*0.85f; if(a<=0.003f) return;
        if(cfg.eraser) blendPx(gx,gy,0,0,0,a,1.f,true);
        else blendPxBuf(gx,gy,cfg.color[0],cfg.color[1],cfg.color[2],a,opa);
    });
}

void BrushEngine::dabPencil(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad),0,cw_-1), y0=clampi((int)(cy-rad),0,ch_-1);
    int x1=clampi((int)(cx+rad),0,cw_-1), y1=clampi((int)(cy+rad),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float d2=sqrf(gx-cx)+sqrf(gy-cy); if(d2>=rr) continue;
        // paperNoise で紙目感を、softAlpha でエッジを作る
        float a=softAlpha(sqrtf(d2)/rad,cfg.hardness)*(paperNoise(gx,gy)*0.8f+0.2f)*flow;
        blendPxBuf(gx,gy,cfg.color[0],cfg.color[1],cfg.color[2],a,opa);
    }
}

void BrushEngine::dabCrayon(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad),0,cw_-1), y0=clampi((int)(cy-rad),0,ch_-1);
    int x1=clampi((int)(cx+rad),0,cw_-1), y1=clampi((int)(cy+rad),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float d2=sqrf(gx-cx)+sqrf(gy-cy); if(d2>=rr) continue;
        // ノイズを二乗してより強い紙目テクスチャにする
        float a=softAlpha(sqrtf(d2)/rad,cfg.hardness)*sqrf(paperNoise(gx,gy))*flow;
        if(a<0.005f) continue;
        int i=(gy*cw_+gx)*4;
        // canvas_ の現在色と 30% 混ぜることでクレヨンらしい不透明感を出す
        blendPxBuf(gx,gy,
            lerpf(cfg.color[0],(float)canvas_[i],0.3f),
            lerpf(cfg.color[1],(float)canvas_[i+1],0.3f),
            lerpf(cfg.color[2],(float)canvas_[i+2],0.3f),
            a,opa);
    }
}

void BrushEngine::dabAirbrush(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    // コア半径の外側はガウス分布で減衰させる
    float coreRad=rad*cfg.hardness;
    float sigma=std::max(1.f,(rad-coreRad)*0.6f);
    float totalRad=coreRad+sigma*3.f, tr2=totalRad*totalRad;
    int x0=clampi((int)(cx-totalRad),0,cw_-1), y0=clampi((int)(cy-totalRad),0,ch_-1);
    int x1=clampi((int)(cx+totalRad),0,cw_-1), y1=clampi((int)(cy+totalRad),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float d2=sqrf(gx-cx)+sqrf(gy-cy); if(d2>tr2) continue;
        float d=sqrtf(d2);
        float a=(d<=coreRad?1.f:expf(-0.5f*sqrf((d-coreRad)/sigma)))*flow;
        if(a>0.003f) blendPxBuf(gx,gy,cfg.color[0],cfg.color[1],cfg.color[2],a,opa);
    }
}

void BrushEngine::dabWatercolor(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    // canvas_（常に合成済み）から周辺色を読んでウェット混色する
    float ar,ag,ab; avgColor(cx,cy,rad*0.6f,ar,ag,ab);
    if(!s_.wetInit){s_.wetR=ar;s_.wetG=ag;s_.wetB=ab;s_.wetInit=true;}
    s_.wetR=lerpf(lerpf(ar,s_.wetR,cfg.spread*0.5f),cfg.color[0],cfg.mixing*0.7f);
    s_.wetG=lerpf(lerpf(ag,s_.wetG,cfg.spread*0.5f),cfg.color[1],cfg.mixing*0.7f);
    s_.wetB=lerpf(lerpf(ab,s_.wetB,cfg.spread*0.5f),cfg.color[2],cfg.mixing*0.7f);
    float rr=rad*rad, f=cfg.water*flow*0.55f;
    int x0=clampi((int)(cx-rad),0,cw_-1), y0=clampi((int)(cy-rad),0,ch_-1);
    int x1=clampi((int)(cx+rad),0,cw_-1), y1=clampi((int)(cy+rad),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float d2=sqrf(gx-cx)+sqrf(gy-cy); if(d2>rr) continue;
        float ni=sqrtf(d2)/rad;
        // 二重ガウスで中心の濃い部分とエッジの淡いにじみを表現する
        float a=(expf(-3.f*ni*ni)+expf(-30.f*sqrf(ni-0.7f))*0.35f)*f*clamp01((1.f-ni)*10.f);
        if(a>0.003f) blendPxBuf(gx,gy,s_.wetR,s_.wetG,s_.wetB,a,opa);
    }
}

void BrushEngine::dabOil(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    float ar,ag,ab; avgColor(cx,cy,rad*0.35f,ar,ag,ab);
    if(!s_.wetInit){s_.wetR=cfg.color[0];s_.wetG=cfg.color[1];s_.wetB=cfg.color[2];s_.wetInit=true;}
    s_.wetR=lerpf(lerpf(s_.wetR,ar,cfg.spread*0.30f),cfg.color[0],cfg.mixing*0.80f);
    s_.wetG=lerpf(lerpf(s_.wetG,ag,cfg.spread*0.30f),cfg.color[1],cfg.mixing*0.80f);
    s_.wetB=lerpf(lerpf(s_.wetB,ab,cfg.spread*0.30f),cfg.color[2],cfg.mixing*0.80f);
    // ストローク方向 (ux,uy) に沿った楕円形ダブで油彩らしい筆跡を作る
    float ux=s_.dirX, uy=s_.dirY, qx=-uy, qy=ux;
    float ra=rad*0.55f, rp=rad;
    float h=clamp01(cfg.hardness-cfg.water*0.2f);
    int x0=clampi((int)(cx-rp),0,cw_-1), y0=clampi((int)(cy-rp),0,ch_-1);
    int x1=clampi((int)(cx+rp),0,cw_-1), y1=clampi((int)(cy+rp),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=gx-cx, dy=gy-cy;
        float al=dx*ux+dy*uy, pe=dx*qx+dy*qy;
        float ed=sqrtf(sqrf(al/ra)+sqrf(pe/rp));
        if(ed>1.15f) continue;
        // sin 変調でエッジに絵具の盛り上がりを表現する
        float ef=clamp01(ed+(0.5f-(sinf(atan2f(pe,al)*9.f)*0.5f+0.5f))*clamp01((ed-0.6f)/0.4f)*0.25f);
        blendPxBuf(gx,gy,s_.wetR,s_.wetG,s_.wetB,softAlpha(ef,h)*flow,opa);
    }
}

void BrushEngine::dabPastel(const BrushCfg& cfg, float cx, float cy, float rad, float flow, float opa) {
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad),0,cw_-1), y0=clampi((int)(cy-rad),0,ch_-1);
    int x1=clampi((int)(cx+rad),0,cw_-1), y1=clampi((int)(cy+rad),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float d2=sqrf(gx-cx)+sqrf(gy-cy); if(d2>=rr) continue;
        float g=paperNoise(gx,gy);
        // ノイズで明暗を反転させてパステル特有のかすれを作る
        float a=softAlpha(sqrtf(d2)/rad,cfg.hardness)*((1.f-g)*0.65f+g*0.35f)*flow*0.7f;
        blendPxBuf(gx,gy,cfg.color[0],cfg.color[1],cfg.color[2],a,opa);
    }
}

void BrushEngine::dabBlur(const BrushCfg& cfg, float cx, float cy, float rad, float flow) {
    int blurKernelRadius=std::max(1,(int)(rad*0.2f));
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad),0,cw_-1), y0=clampi((int)(cy-rad),0,ch_-1);
    int x1=clampi((int)(cx+rad),0,cw_-1), y1=clampi((int)(cy+rad),0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float d2=sqrf(gx-cx)+sqrf(gy-cy); if(d2>=rr) continue;
        float st=softAlpha(sqrtf(d2)/rad,0.f)*flow; if(st<0.005f) continue;
        // alphaBuf_ で各ピクセルの最大アルファを管理し、同じ場所を何度もぼかさない
        int pixelIdx=gy*cw_+gx; if(st<=alphaBuf_[pixelIdx]) continue; alphaBuf_[pixelIdx]=st;
        float sumR=0,sumG=0,sumB=0,sumA=0; int sampleCount=0;
        for(int ky=gy-blurKernelRadius;ky<=gy+blurKernelRadius;ky++){
            for(int kx=gx-blurKernelRadius;kx<=gx+blurKernelRadius;kx++){
                if(ky>=0&&ky<ch_&&kx>=0&&kx<cw_){
                    int k=(ky*cw_+kx)*4;
                    // preStroke_ を参照することでストロークの自己ブレンドを防ぐ
                    sumR+=preStroke_[k]; sumG+=preStroke_[k+1];
                    sumB+=preStroke_[k+2]; sumA+=preStroke_[k+3];
                    sampleCount++;
                }
            }
        }
        if(sampleCount){
            int idx=pixelIdx*4;
            canvas_[idx]  =(uint8_t)lerpf(preStroke_[idx],  sumR/sampleCount,st);
            canvas_[idx+1]=(uint8_t)lerpf(preStroke_[idx+1],sumG/sampleCount,st);
            canvas_[idx+2]=(uint8_t)lerpf(preStroke_[idx+2],sumB/sampleCount,st);
            canvas_[idx+3]=(uint8_t)lerpf(preStroke_[idx+3],sumA/sampleCount,st);
        }
    }
    // cfg はこの関数では使用しないが、他のダブと引数を揃えるために受け取っている
    (void)cfg;
}
