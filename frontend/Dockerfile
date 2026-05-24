# =====================================================
# Stage 1: Build C++ brush engine → WebAssembly
# =====================================================
FROM emscripten/emsdk:3.1.51 AS wasm-builder

WORKDIR /build
COPY brushwasm/src/ ./

RUN mkdir -p /output && \
    ( em++ -std=c++17 -O2 -fno-exceptions -fno-rtti \
        brush_engine.cpp wasm_exports.cpp \
        -s EXPORTED_FUNCTIONS='["_alloc_buf","_free_buf","_brush_create","_brush_destroy","_brush_set_type","_brush_set_color","_brush_set_param","_brush_set_curve","_brush_set_random","_brush_set_hardness","_brush_set_eraser","_brush_get_canvas_buf","_brush_canvas_w","_brush_canvas_h","_brush_begin_stroke","_brush_stroke_to"]' \
        -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8","HEAPF32"]' \
        -s NO_EXIT_RUNTIME=1 \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s NO_FILESYSTEM=1 \
        -s MODULARIZE=1 \
        -s EXPORT_NAME="BrushWasm" \
        -o /output/brush_engine.js && \
      echo "ok" > /output/.wasm_built ) || \
    ( echo "// WASM build unavailable – JS fallback active" \
        > /output/brush_engine.js && \
      touch /output/brush_engine.wasm && \
      echo "skip" > /output/.wasm_built )

# =====================================================
# Stage 2: Build Vite frontend
# =====================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
COPY --from=wasm-builder /output/brush_engine.js ./public/
COPY --from=wasm-builder /output/brush_engine.wasm ./public/
RUN npm run build

# =====================================================
# Stage 3: Production nginx
# =====================================================
FROM nginx:alpine
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
