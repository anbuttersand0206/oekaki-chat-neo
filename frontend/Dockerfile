# =====================================================
# Stage 1: Build C++ brush engine → WebAssembly
# =====================================================
FROM emscripten/emsdk:3.1.51 AS wasm-builder

WORKDIR /build
COPY brushwasm/src/ ./

RUN mkdir -p /output && \
    ( em++ -std=c++17 \
        brush_engine.cpp wasm_exports.cpp \
        -lm \
        -O3 \
        -s EXPORTED_FUNCTIONS="['_alloc_pixels','_free_pixels','_brush_create','_brush_destroy','_brush_set_color','_brush_set_param','_brush_set_curve','_brush_set_random','_brush_begin_stroke','_brush_stroke_dab']" \
        -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','setValue','getValue']" \
        -s NO_EXIT_RUNTIME=1 \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s NO_FILESYSTEM=1 \
        -s MODULARIZE=1 \
        -s EXPORT_NAME="BrushWasmModule" \
        -s SINGLE_FILE=1 \
        -o /output/brush-wasm.js && \
      echo "ok" > /output/.wasm_built ) || \
    ( echo "// WASM build unavailable – JS fallback active" \
        > /output/brush-wasm.js && \
      echo "skip" > /output/.wasm_built )

# =====================================================
# Stage 2: Build Vite frontend
# =====================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
COPY --from=wasm-builder /output/brush-wasm.js ./public/
RUN npm run build

# =====================================================
# Stage 3: Production nginx
# =====================================================
FROM nginx:alpine
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
