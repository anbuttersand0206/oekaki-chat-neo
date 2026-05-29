CXX      = em++
# -fno-exceptions -fno-rtti: 例外と RTTI を無効化して Wasm バイナリを削減する
CXXFLAGS = -std=c++17 -O2 -fno-exceptions -fno-rtti

SRC = src/brush_engine.cpp src/wasm_exports.cpp
OUT = ../frontend/public/brush_engine.js

EXPORTS = '["_alloc_buf","_free_buf","_brush_create","_brush_destroy","_brush_set_type","_brush_set_color","_brush_set_param","_brush_set_curve","_brush_set_random","_brush_set_hardness","_brush_set_eraser","_brush_get_canvas_buf","_brush_canvas_w","_brush_canvas_h","_brush_begin_stroke","_brush_stroke_to"]'

EMFLAGS = \
	-s MODULARIZE=1 \
	-s EXPORT_NAME=BrushWasm \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s NO_EXIT_RUNTIME=1 \
	-s EXPORTED_FUNCTIONS=$(EXPORTS) \
	-s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8","HEAPF32"]' \
	-s ENVIRONMENT=web

all: $(OUT)

$(OUT): $(SRC) src/brush_engine.h
	$(CXX) $(CXXFLAGS) $(EMFLAGS) -o $(OUT) $(SRC)

rebuild: clean all

clean:
	rm -f $(OUT) ../frontend/public/brush_engine.wasm

.PHONY: all rebuild clean
