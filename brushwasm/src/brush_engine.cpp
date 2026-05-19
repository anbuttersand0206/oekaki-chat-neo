#include "brush_engine.h"
#include <cmath>
#include <cstring>
#include <algorithm>

// ── Utilities ─────────────────────────────────────────────────────────────────
static inline float clamp01(float v){ return v<0?0:v>1?1:v; }
static inline float lerpf(float a,float b,float t){ return a+(b-a)*t; }
static inline int   clampi(int v,int lo,int hi){ return v<lo?lo:v>hi?hi:v; }
static inline float sqrf(float x){ return x*x; }

// ── RNG / curve ───────────────────────────────────────────────────────────────
float BrushEngine::rng() {
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

// ── softAlpha: Gaussian falloff (quintic smooth-step) ─────────────────────────
float BrushEngine::softAlpha(float d, float hardness){
    if(d>=1.f) return 0.f;
    if(hardness>=1.f||d<=hardness) return 1.f;
    float t=(d-hardness)/(1.f-hardness+1e-7f);
    t=t*t*t*(t*(t*6.f-15.f)+10.f); // quintic easing
    return 1.f-t;
}

// ── Paper noise (deterministic hash) ─────────────────────────────────────────
float BrushEngine::paperNoise(int cx,int cy) const {
    uint32_t h=(uint32_t)(cx*2654435761u)^(uint32_t)(cy*2246822519u);
    h^=h>>16; h*=0x45d9f3bu; h^=h>>16;
    uint32_t h2=(uint32_t)((cx/2)*2654435761u)^(uint32_t)((cy/2)*2246822519u);
    h2^=h2>>16; h2*=0x45d9f3bu; h2^=h2>>16;
    return (h&0xFF)/255.f*0.6f+(h2&0xFF)/255.f*0.4f;
}

// ── Average colour in a small region (two variants: live canvas / pre-stroke) ──
void BrushEngine::avgColor(float cx,float cy,float r,float& ar,float& ag,float& ab) const {
    avgColorFrom(canvas_,cx,cy,r,ar,ag,ab);
}
void BrushEngine::avgColorFrom(const std::vector<uint8_t>& src,float cx,float cy,float r,
                                float& ar,float& ag,float& ab) const {
    int sr=std::max(1,(int)(r*0.4f));
    int x0=clampi((int)(cx-sr),0,cw_-1), y0=clampi((int)(cy-sr),0,ch_-1);
    int x1=clampi((int)(cx+sr),0,cw_-1), y1=clampi((int)(cy+sr),0,ch_-1);
    float sr2=0,sg=0,sb=0; int cnt=0;
    for(int y=y0;y<=y1;y++) for(int x=x0;x<=x1;x++){
        int i=(y*cw_+x)*4;
        sr2+=src[i]; sg+=src[i+1]; sb+=src[i+2]; cnt++;
    }
    if(cnt>0){ar=sr2/cnt;ag=sg/cnt;ab=sb/cnt;}
    else ar=ag=ab=255.f;
}

// ── Canvas buffer management ─────────────────────────────────────────────────
uint8_t* BrushEngine::getCanvasBuf(int cw,int ch){
    if(cw!=cw_||ch!=ch_){
        cw_=cw; ch_=ch;
        canvas_.resize(cw*ch*4,255);
        preStroke_.resize(cw*ch*4,255);
        alphaBuf_.resize(cw*ch,0.f);
    }
    return canvas_.data();
}

// ── Stroke interface ──────────────────────────────────────────────────────────
void BrushEngine::beginStroke(float x,float y,float pressure,float /*speed*/,const BrushCfg& cfg){
    s_.prevX=x; s_.prevY=y; s_.prevP=pressure;
    s_.distAccum=0; s_.wetInit=false;
    // Snapshot canvas for max-alpha compositing
    preStroke_=canvas_;
    std::fill(alphaBuf_.begin(),alphaBuf_.end(),0.f);
    (void)cfg;
}

void BrushEngine::strokeTo(float x,float y,float pressure,float speed,const BrushCfg& cfg){
    float dx=x-s_.prevX, dy=y-s_.prevY;
    float dist=sqrtf(dx*dx+dy*dy);
    if(dist<0.5f) return;

    s_.dirX=dx/dist; s_.dirY=dy/dist;
    float ns=clamp01(speed/1000.f);

    float szRaw=std::max(0.01f,resolve(ParamId::Size,   cfg.size,   pressure,ns,cfg));
    float opa  =clamp01(       resolve(ParamId::Opacity,cfg.opacity,pressure,ns,cfg));
    float den  =clamp01(       resolve(ParamId::Density,cfg.density,pressure,ns,cfg));
    float spc  =std::max(0.01f,resolve(ParamId::Spacing,cfg.spacing,pressure,ns,cfg));

    float cov     =szRaw<1.f?szRaw:1.f;
    float radius  =std::max(1.f,szRaw)*0.5f;
    float alpha   =opa*den*cov;
    float spacing =std::max(1.f,spc*szRaw);

    int steps=(int)ceilf(dist/spacing);
    float leftover=spacing-fmodf(s_.distAccum,spacing);
    float startFrac=leftover/dist;

    for(int i=0;i<steps;i++){
        float t=startFrac+(float)i/(float)steps*(1.f-startFrac);
        if(t>1.f) break;
        float cx=s_.prevX+dx*t;
        float cy=s_.prevY+dy*t;
        float cp=s_.prevP+(pressure-s_.prevP)*t;
        // Recalculate per-dab alpha with interpolated pressure
        float da=clamp01(resolve(ParamId::Opacity,cfg.opacity,cp,ns,cfg))
                *clamp01(resolve(ParamId::Density,cfg.density,cp,ns,cfg))*cov;
        float rad2=std::max(1.f,resolve(ParamId::Size,cfg.size,cp,ns,cfg))*0.5f;
        dab(cfg,cx,cy,rad2,da);
    }

    s_.distAccum+=dist;
    s_.prevX=x; s_.prevY=y; s_.prevP=pressure;
    (void)radius; (void)alpha;
}

// ── Dab dispatcher ────────────────────────────────────────────────────────────
void BrushEngine::dab(const BrushCfg& cfg,float cx,float cy,float rad,float opa){
    switch(cfg.type){
        case BrushType::Pen:        dabPen       (cfg,cx,cy,rad,opa); break;
        case BrushType::Marker:     dabMarker    (cfg,cx,cy,rad,opa); break;
        case BrushType::Pencil:     dabPencil    (cfg,cx,cy,rad,opa); break;
        case BrushType::Crayon:     dabCrayon    (cfg,cx,cy,rad,opa); break;
        case BrushType::Airbrush:   dabAirbrush  (cfg,cx,cy,rad,opa); break;
        case BrushType::Watercolor: dabWatercolor(cfg,cx,cy,rad,opa); break;
        case BrushType::Oil:        dabOil       (cfg,cx,cy,rad,opa); break;
        case BrushType::Pastel:     dabPastel    (cfg,cx,cy,rad,opa); break;
        case BrushType::Blur:       dabBlur      (cfg,cx,cy,rad,opa); break;
    }
}

// ── Pixel blend helpers ───────────────────────────────────────────────────────

// Standard Porter-Duff over onto live canvas_
void BrushEngine::blendPx(int gx,int gy,float r,float g,float b,float alpha,bool eraser){
    if(gx<0||gy<0||gx>=cw_||gy>=ch_) return;
    if(alpha<=0.003f) return;
    alpha=clamp01(alpha);
    int idx=(gy*cw_+gx)*4;
    uint8_t* p=canvas_.data()+idx;
    if(eraser){
        float da=p[3]/255.f;
        p[3]=(uint8_t)(clamp01(da*(1.f-alpha))*255.f);
        return;
    }
    float da=p[3]/255.f, sa=alpha;
    float outA=sa+da*(1.f-sa);
    if(outA<1e-5f){p[3]=0;return;}
    float inv=1.f/outA;
    p[0]=(uint8_t)((r*sa+p[0]*da*(1.f-sa))*inv);
    p[1]=(uint8_t)((g*sa+p[1]*da*(1.f-sa))*inv);
    p[2]=(uint8_t)((b*sa+p[2]*da*(1.f-sa))*inv);
    p[3]=(uint8_t)(outA*255.f);
}

// Max-alpha composite against preStroke_ snapshot — prevents within-stroke buildup
void BrushEngine::blendPxBuf(int gx,int gy,float r,float g,float b,float alpha,bool eraser){
    if(gx<0||gy<0||gx>=cw_||gy>=ch_) return;
    if(alpha<=0.003f) return;
    alpha=clamp01(alpha);
    int bi=gy*cw_+gx;
    if(alpha<=alphaBuf_[bi]) return;
    alphaBuf_[bi]=alpha;

    int pi=bi*4;
    int li=pi; // same coords in canvas_
    const uint8_t* pre=preStroke_.data();
    uint8_t* dst=canvas_.data();

    if(eraser){
        dst[li+0]=pre[pi+0];
        dst[li+1]=pre[pi+1];
        dst[li+2]=pre[pi+2];
        dst[li+3]=(uint8_t)(clamp01(pre[pi+3]/255.f*(1.f-alpha))*255.f);
        return;
    }
    float da=pre[pi+3]/255.f, sa=alpha;
    float outA=sa+da*(1.f-sa);
    if(outA<1e-5f){dst[li+3]=0;return;}
    float inv=1.f/outA;
    dst[li+0]=(uint8_t)((r*sa+pre[pi+0]*da*(1.f-sa))*inv);
    dst[li+1]=(uint8_t)((g*sa+pre[pi+1]*da*(1.f-sa))*inv);
    dst[li+2]=(uint8_t)((b*sa+pre[pi+2]*da*(1.f-sa))*inv);
    dst[li+3]=(uint8_t)(outA*255.f);
}

// ── N×N oversampled circle with two-zone hardness ─────────────────────────────
// Zone 1 — inner core (d <= hardness*r): full coverage = 1.0
// Zone 2 — outer edge (hardness*r < d < r): cubic smoothstep falloff to 0
//   s = (d - innerR) / (r - innerR),  coverage = 1 - s²(3 - 2s)
// Calls fn(gx, gy, coverage) for each covered pixel.
template<typename Fn>
static void iterCircleDab(float cx, float cy, float rad, float hardness,
                          int cw, int ch, Fn fn) {
    const int   N      = rad<3.f?11:rad<15.f?5:3;
    const float invN   = 1.f/N;
    const float invNN  = 1.f/(N*N);
    const float rr     = rad*rad;
    const bool  isHard = hardness>=0.999f;
    const float innerR = rad*hardness;
    const float innerRR= innerR*innerR;
    const float edgeW  = rad-innerR+1e-6f;

    int x0=clampi((int)(cx-rad),  0,cw-1);
    int y0=clampi((int)(cy-rad),  0,ch-1);
    int x1=clampi((int)(cx+rad)+1,0,cw-1);
    int y1=clampi((int)(cy+rad)+1,0,ch-1);

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
                    if(isHard||d2<=innerRR){
                        sum+=1.f;
                    } else {
                        float s=clamp01((sqrtf(d2)-innerR)/edgeW);
                        sum+=1.f-s*s*(3.f-2.f*s); // cubic smoothstep
                    }
                }
            }
            if(sum>0.f) fn(gx,gy,sum*invNN);
        }
    }
}

// ── Pen — N×N oversampled, max-alpha compositing ─────────────────────────────
void BrushEngine::dabPen(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float r=cfg.color[0], g=cfg.color[1], b=cfg.color[2];
    bool  er=cfg.eraser;
    iterCircleDab(cx,cy,rad,cfg.hardness,cw_,ch_,[&](int gx,int gy,float alpha){
        float a=alpha*opa;
        if(a>0.003f) blendPxBuf(gx,gy,r,g,b,a,er);
    });
}

// ── Marker — N×N oversampled, max-alpha compositing ──────────────────────────
void BrushEngine::dabMarker(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float r=cfg.color[0], g=cfg.color[1], b=cfg.color[2];
    bool  er=cfg.eraser;
    iterCircleDab(cx,cy,rad,cfg.hardness,cw_,ch_,[&](int gx,int gy,float alpha){
        float a=alpha*opa*0.85f;
        if(a>0.003f) blendPxBuf(gx,gy,r,g,b,a,er);
    });
}

// ── Pencil — paper-grain texture ─────────────────────────────────────────────
void BrushEngine::dabPencil(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float r=cfg.color[0],g=cfg.color[1],b=cfg.color[2];
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad)-1,0,cw_-1), y0=clampi((int)(cy-rad)-1,0,ch_-1);
    int x1=clampi((int)(cx+rad)+1,0,cw_-1), y1=clampi((int)(cy+rad)+1,0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=gx-cx, dy=gy-cy;
        float d2=dx*dx+dy*dy;
        if(d2>=rr) continue;
        float d=sqrtf(d2)/rad;
        float grain=paperNoise(gx,gy);
        float a=softAlpha(d,cfg.hardness)*(grain*0.8f+0.2f)*opa;
        blendPxBuf(gx,gy,r,g,b,a,cfg.eraser);
    }
}

// ── Crayon — waxy grain ────────────────────────────────────────────────────────
void BrushEngine::dabCrayon(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad)-1,0,cw_-1), y0=clampi((int)(cy-rad)-1,0,ch_-1);
    int x1=clampi((int)(cx+rad)+1,0,cw_-1), y1=clampi((int)(cy+rad)+1,0,ch_-1);
    const uint8_t* pre=preStroke_.data();
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=gx-cx, dy=gy-cy;
        float d2=dx*dx+dy*dy;
        if(d2>=rr) continue;
        float d=sqrtf(d2)/rad;
        float grain=paperNoise(gx,gy);
        float a=softAlpha(d,cfg.hardness)*sqrf(grain)*opa;
        if(a<0.005f) continue;
        // Read wax base from pre-stroke snapshot
        int pi=(gy*cw_+gx)*4;
        float fr=lerpf(cfg.color[0],pre[pi+0],0.3f);
        float fg=lerpf(cfg.color[1],pre[pi+1],0.3f);
        float fb=lerpf(cfg.color[2],pre[pi+2],0.3f);
        blendPxBuf(gx,gy,fr,fg,fb,a,false);
    }
}

// ── Airbrush — Gaussian falloff with optional core ────────────────────────────
void BrushEngine::dabAirbrush(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float r=cfg.color[0],g=cfg.color[1],b=cfg.color[2];
    float coreRad  = rad * cfg.hardness;
    float sigma    = std::max(1.f, (rad - coreRad) * 0.6f);
    float totalRad = coreRad + sigma * 3.f;
    float tr2      = totalRad * totalRad;
    float outer    = totalRad + 0.5f;
    float outerR2  = outer * outer;

    int x0=clampi((int)(cx-totalRad)-1,0,cw_-1);
    int y0=clampi((int)(cy-totalRad)-1,0,ch_-1);
    int x1=clampi((int)(cx+totalRad)+1,0,cw_-1);
    int y1=clampi((int)(cy+totalRad)+1,0,ch_-1);

    for(int gy=y0;gy<=y1;gy++){
        for(int gx=x0;gx<=x1;gx++){
            float dx=gx-cx,dy=gy-cy;
            float d2=dx*dx+dy*dy;
            if(d2>outerR2) continue;
            float dist=sqrtf(d2);
            float aa=(d2>tr2)?std::max(0.f,outer-dist)*2.f:1.f;
            float alpha=(dist<=coreRad)
                ? opa
                : expf(-0.5f*sqrf((dist-coreRad)/sigma))*opa;
            if(alpha*aa>0.003f) blendPxBuf(gx,gy,r,g,b,alpha*aa,cfg.eraser);
        }
    }
}

// ── Watercolor — soft Gaussian + pigment rim + diffusion bleed ────────────────
void BrushEngine::dabWatercolor(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float avgR,avgG,avgB;
    avgColorFrom(preStroke_,cx,cy,rad*0.6f,avgR,avgG,avgB);

    if(!s_.wetInit){s_.wetR=avgR;s_.wetG=avgG;s_.wetB=avgB;s_.wetInit=true;}
    s_.wetR=lerpf(avgR,s_.wetR,cfg.spread*0.5f); s_.wetR=lerpf(s_.wetR,cfg.color[0],cfg.mixing*0.7f);
    s_.wetG=lerpf(avgG,s_.wetG,cfg.spread*0.5f); s_.wetG=lerpf(s_.wetG,cfg.color[1],cfg.mixing*0.7f);
    s_.wetB=lerpf(avgB,s_.wetB,cfg.spread*0.5f); s_.wetB=lerpf(s_.wetB,cfg.color[2],cfg.mixing*0.7f);

    float flow = cfg.water * opa * 0.55f;
    float dRR = rad*rad;

    int x0=clampi((int)(cx-rad)-1,0,cw_-1), y0=clampi((int)(cy-rad)-1,0,ch_-1);
    int x1=clampi((int)(cx+rad)+1,0,cw_-1), y1=clampi((int)(cy+rad)+1,0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=gx-cx,dy=gy-cy;
        float d2=dx*dx+dy*dy;
        if(d2>dRR) continue;
        float normInner=sqrtf(d2)/rad;
        float g=expf(-3.f*normInner*normInner);
        float rim=expf(-30.f*sqrf(normInner-0.7f))*0.35f;
        float edge=clamp01((1.f-normInner)*10.f);
        float a=(g+rim)*flow*edge;
        if(a>0.003f) blendPxBuf(gx,gy,s_.wetR,s_.wetG,s_.wetB,a,false);
    }
}

// ── Oil — directional flat-brush ellipse ──────────────────────────────────────
void BrushEngine::dabOil(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float canR,canG,canB;
    avgColorFrom(preStroke_,cx,cy,rad*0.35f,canR,canG,canB);
    if(!s_.wetInit){s_.wetR=cfg.color[0];s_.wetG=cfg.color[1];s_.wetB=cfg.color[2];s_.wetInit=true;}
    s_.wetR=lerpf(lerpf(s_.wetR,canR,cfg.spread*0.45f),cfg.color[0],cfg.mixing*0.55f);
    s_.wetG=lerpf(lerpf(s_.wetG,canG,cfg.spread*0.45f),cfg.color[1],cfg.mixing*0.55f);
    s_.wetB=lerpf(lerpf(s_.wetB,canB,cfg.spread*0.45f),cfg.color[2],cfg.mixing*0.55f);

    float ux=s_.dirX,uy=s_.dirY, qx=-uy,qy=ux;
    const float FLAT=0.55f;
    float radAlong=rad*FLAT, radPerp=rad;
    float h=clamp01(cfg.hardness-cfg.water*0.2f);

    int x0=clampi((int)(cx-radPerp)-1,0,cw_-1), y0=clampi((int)(cy-radPerp)-1,0,ch_-1);
    int x1=clampi((int)(cx+radPerp)+1,0,cw_-1), y1=clampi((int)(cy+radPerp)+1,0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=(float)gx-cx, dy=(float)gy-cy;
        float along=dx*ux+dy*uy, perp=dx*qx+dy*qy;
        float ellD=sqrtf(sqrf(along/radAlong)+sqrf(perp/radPerp));
        if(ellD>1.15f) continue;
        float edgeFrac=clamp01((ellD-0.6f)/0.4f);
        float bWave=sinf(atan2f(perp,along)*9.f)*0.5f+0.5f;
        float effD=clamp01(ellD+(0.5f-bWave)*edgeFrac*0.25f);
        float a=softAlpha(effD,h)*opa;
        blendPxBuf(gx,gy,s_.wetR,s_.wetG,s_.wetB,a,false);
    }
}

// ── Pastel — chalky valleys ───────────────────────────────────────────────────
void BrushEngine::dabPastel(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    float r=cfg.color[0],g=cfg.color[1],b=cfg.color[2];
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad)-1,0,cw_-1), y0=clampi((int)(cy-rad)-1,0,ch_-1);
    int x1=clampi((int)(cx+rad)+1,0,cw_-1), y1=clampi((int)(cy+rad)+1,0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=gx-cx,dy=gy-cy;
        float d2=dx*dx+dy*dy;
        if(d2>=rr) continue;
        float d=sqrtf(d2)/rad;
        float grain=paperNoise(gx,gy);
        float texOpa=(1.f-grain)*0.65f+grain*0.35f;
        float a=softAlpha(d,cfg.hardness)*texOpa*opa*0.7f;
        blendPxBuf(gx,gy,r,g,b,a,false);
    }
}

// ── Blur — box-blur using pre-stroke snapshot + max-strength guard ───────────
// Sampling from preStroke_ (not the live canvas) prevents dab overlap from
// compounding the blur and causing uneven colour patches.
void BrushEngine::dabBlur(const BrushCfg& cfg, float cx, float cy, float rad, float opa) {
    int blurKR=std::max(1,(int)(rad*0.2f));
    float rr=rad*rad;
    int x0=clampi((int)(cx-rad)-1,0,cw_-1), y0=clampi((int)(cy-rad)-1,0,ch_-1);
    int x1=clampi((int)(cx+rad)+1,0,cw_-1), y1=clampi((int)(cy+rad)+1,0,ch_-1);
    for(int gy=y0;gy<=y1;gy++) for(int gx=x0;gx<=x1;gx++){
        float dx=gx-cx,dy=gy-cy;
        float d2=dx*dx+dy*dy;
        if(d2>=rr) continue;
        float d=sqrtf(d2)/rad;
        float strength=softAlpha(d,0.f)*opa;
        if(strength<0.005f) continue;
        int bi=gy*cw_+gx;
        if(strength<=alphaBuf_[bi]) continue; // already written at higher strength
        alphaBuf_[bi]=strength;
        float sumR=0,sumG=0,sumB=0,sumA=0; int cnt=0;
        for(int ky=gy-blurKR;ky<=gy+blurKR;ky++){
            if(ky<0||ky>=ch_) continue;
            for(int kx=gx-blurKR;kx<=gx+blurKR;kx++){
                if(kx<0||kx>=cw_) continue;
                int kidx=(ky*cw_+kx)*4;
                sumR+=preStroke_[kidx];sumG+=preStroke_[kidx+1];
                sumB+=preStroke_[kidx+2];sumA+=preStroke_[kidx+3];cnt++;
            }
        }
        if(!cnt) continue;
        int idx=bi*4;
        canvas_[idx+0]=(uint8_t)lerpf(preStroke_[idx+0],sumR/cnt,strength);
        canvas_[idx+1]=(uint8_t)lerpf(preStroke_[idx+1],sumG/cnt,strength);
        canvas_[idx+2]=(uint8_t)lerpf(preStroke_[idx+2],sumB/cnt,strength);
        canvas_[idx+3]=(uint8_t)lerpf(preStroke_[idx+3],sumA/cnt,strength);
    }
    (void)cfg;
}
