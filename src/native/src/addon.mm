// addon.mm — N-API addon entry point for the Ghostty native module
//
// Exposes the following functions to Node.js:
//   ghosttyInit()                    → boolean
//   ghosttyGetVersion()              → string
//   ghosttyCreateSurface(handle, rect, opts) → number (surface ID)
//   ghosttySetFrame(surfaceId, rect) → void
//   ghosttySetSize(surfaceId, w, h)  → void
//   ghosttyKeyEvent(surfaceId, evt)  → boolean
//   ghosttyMouseButton(surfaceId, state, button, mods) → void
//   ghosttyMousePos(surfaceId, x, y, mods) → void
//   ghosttyMouseScroll(surfaceId, dx, dy, mods) → void
//   ghosttySetFocus(surfaceId, focused) → void
//   ghosttyDestroySurface(surfaceId) → void
//   ghosttyShutdown()                → void

#include <napi.h>
#import <Cocoa/Cocoa.h>
#include "ghostty_bridge.h"
#include "nsview_host.h"

using namespace ghostty;

// ---------------------------------------------------------------------------
// ghosttyInit() → boolean
// ---------------------------------------------------------------------------
Napi::Value GhosttyInit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool result = GhosttyBridge::instance().init();
  return Napi::Boolean::New(env, result);
}

// ---------------------------------------------------------------------------
// ghosttyGetVersion() → string
// ---------------------------------------------------------------------------
Napi::Value GhosttyGetVersion(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string version = GhosttyBridge::instance().getVersion();
  return Napi::String::New(env, version);
}

// ---------------------------------------------------------------------------
// ghosttyCreateSurface(windowHandle: Buffer, rect: {x,y,w,h}, opts: {
//   cwd?: string, shell?: string, scaleFactor: number, fontSize?: number
// }) → number (surface ID, 0 on failure)
// ---------------------------------------------------------------------------
Napi::Value GhosttyCreateSurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3) {
    Napi::TypeError::New(env, "Expected 3 arguments: windowHandle, rect, opts")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }

  // Arg 0: windowHandle (Buffer)
  if (!info[0].IsBuffer()) {
    Napi::TypeError::New(env, "First argument must be a Buffer (window handle)")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }
  Napi::Buffer<uint8_t> handleBuf = info[0].As<Napi::Buffer<uint8_t>>();
  NSWindow* window = windowFromHandle(handleBuf.Data(), handleBuf.Length());
  if (!window) {
    Napi::Error::New(env, "Failed to extract NSWindow from handle")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }

  // Arg 1: rect {x, y, w, h}
  if (!info[1].IsObject()) {
    Napi::TypeError::New(env, "Second argument must be an object {x, y, w, h}")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }
  Napi::Object rectObj = info[1].As<Napi::Object>();
  ViewRect rect;
  rect.x = rectObj.Get("x").As<Napi::Number>().DoubleValue();
  rect.y = rectObj.Get("y").As<Napi::Number>().DoubleValue();
  rect.width = rectObj.Get("w").As<Napi::Number>().DoubleValue();
  rect.height = rectObj.Get("h").As<Napi::Number>().DoubleValue();

  // Arg 2: opts {cwd?, shell?, scaleFactor}
  if (!info[2].IsObject()) {
    Napi::TypeError::New(env, "Third argument must be an object {cwd, shell, scaleFactor}")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }
  Napi::Object opts = info[2].As<Napi::Object>();

  std::string cwd;
  if (opts.Has("cwd") && opts.Get("cwd").IsString()) {
    cwd = opts.Get("cwd").As<Napi::String>().Utf8Value();
  }

  std::string shell;
  if (opts.Has("shell") && opts.Get("shell").IsString()) {
    shell = opts.Get("shell").As<Napi::String>().Utf8Value();
  }

  double scaleFactor = 2.0; // Default to Retina
  if (opts.Has("scaleFactor") && opts.Get("scaleFactor").IsNumber()) {
    scaleFactor = opts.Get("scaleFactor").As<Napi::Number>().DoubleValue();
  }

  float fontSize = 0.0f; // 0 = use Ghostty config default
  if (opts.Has("fontSize") && opts.Get("fontSize").IsNumber()) {
    fontSize = static_cast<float>(opts.Get("fontSize").As<Napi::Number>().DoubleValue());
  }

  // Create the host NSView
  NSView* hostView = createHostView(window, rect);
  if (!hostView) {
    Napi::Error::New(env, "Failed to create host NSView")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }

  // Create the Ghostty surface on this view
  uint32_t surfaceId = GhosttyBridge::instance().createSurface(
    hostView, scaleFactor, fontSize, cwd, shell
  );

  if (surfaceId == 0) {
    destroyHostView(hostView);
    Napi::Error::New(env, "Failed to create Ghostty surface")
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, 0);
  }

  setHostViewSurfaceId(hostView, surfaceId);

  return Napi::Number::New(env, surfaceId);
}

// ---------------------------------------------------------------------------
// ghosttySetFrame(surfaceId: number, rect: {x, y, w, h}) → void
// ---------------------------------------------------------------------------
void GhosttySetFrame(const Napi::CallbackInfo& info) {
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) return;

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  Napi::Object rectObj = info[1].As<Napi::Object>();

  double x = rectObj.Get("x").As<Napi::Number>().DoubleValue();
  double y = rectObj.Get("y").As<Napi::Number>().DoubleValue();
  double w = rectObj.Get("w").As<Napi::Number>().DoubleValue();
  double h = rectObj.Get("h").As<Napi::Number>().DoubleValue();

  GhosttyBridge::instance().setFrame(surfaceId, x, y, w, h);
}

// ---------------------------------------------------------------------------
// ghosttySetSize(surfaceId: number, width: number, height: number) → void
// ---------------------------------------------------------------------------
void GhosttySetSize(const Napi::CallbackInfo& info) {
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
    return;
  }

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  uint32_t width = info[1].As<Napi::Number>().Uint32Value();
  uint32_t height = info[2].As<Napi::Number>().Uint32Value();

  GhosttyBridge::instance().setSize(surfaceId, width, height);
}

// ---------------------------------------------------------------------------
// ghosttyKeyEvent(surfaceId: number, event: {
//   action: number,
//   keycode: number,
//   mods: number,
//   consumedMods?: number,
//   text?: string,
//   unshiftedCodepoint?: number,
//   composing?: boolean
// }) → boolean
// ---------------------------------------------------------------------------
Napi::Value GhosttyKeyEvent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsObject()) {
    return Napi::Boolean::New(env, false);
  }

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  Napi::Object eventObj = info[1].As<Napi::Object>();

  auto action = static_cast<ghostty_input_action_e>(
    eventObj.Get("action").As<Napi::Number>().Int32Value()
  );

  // Backward compatibility: accept either `keycode` (preferred) or legacy `key`.
  uint32_t keycode = 0;
  if (eventObj.Has("keycode") && eventObj.Get("keycode").IsNumber()) {
    keycode = eventObj.Get("keycode").As<Napi::Number>().Uint32Value();
  } else if (eventObj.Has("key") && eventObj.Get("key").IsNumber()) {
    keycode = eventObj.Get("key").As<Napi::Number>().Uint32Value();
  }

  auto mods = static_cast<ghostty_input_mods_e>(
    eventObj.Get("mods").As<Napi::Number>().Int32Value()
  );

  auto consumedMods = mods;
  if (eventObj.Has("consumedMods") && eventObj.Get("consumedMods").IsNumber()) {
    consumedMods = static_cast<ghostty_input_mods_e>(
      eventObj.Get("consumedMods").As<Napi::Number>().Int32Value()
    );
  }

  std::string text;
  if (eventObj.Has("text") && eventObj.Get("text").IsString()) {
    text = eventObj.Get("text").As<Napi::String>().Utf8Value();
  }

  uint32_t unshiftedCodepoint = 0;
  if (eventObj.Has("unshiftedCodepoint") && eventObj.Get("unshiftedCodepoint").IsNumber()) {
    unshiftedCodepoint = eventObj.Get("unshiftedCodepoint").As<Napi::Number>().Uint32Value();
  }

  bool composing = false;
  if (eventObj.Has("composing") && eventObj.Get("composing").IsBoolean()) {
    composing = eventObj.Get("composing").As<Napi::Boolean>().Value();
  }

  bool consumed = GhosttyBridge::instance().keyEvent(
    surfaceId,
    action,
    keycode,
    mods,
    consumedMods,
    text,
    unshiftedCodepoint,
    composing
  );
  return Napi::Boolean::New(env, consumed);
}

// ---------------------------------------------------------------------------
// ghosttyMouseButton(surfaceId, state, button, mods) → void
// ---------------------------------------------------------------------------
void GhosttyMouseButton(const Napi::CallbackInfo& info) {
  if (info.Length() < 4) return;

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  auto state = static_cast<ghostty_input_mouse_state_e>(
    info[1].As<Napi::Number>().Int32Value()
  );
  auto button = static_cast<ghostty_input_mouse_button_e>(
    info[2].As<Napi::Number>().Int32Value()
  );
  auto mods = static_cast<ghostty_input_mods_e>(
    info[3].As<Napi::Number>().Int32Value()
  );

  GhosttyBridge::instance().mouseButton(surfaceId, state, button, mods);
}

// ---------------------------------------------------------------------------
// ghosttyMousePos(surfaceId, x, y, mods) → void
// ---------------------------------------------------------------------------
void GhosttyMousePos(const Napi::CallbackInfo& info) {
  if (info.Length() < 4) return;

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  double x = info[1].As<Napi::Number>().DoubleValue();
  double y = info[2].As<Napi::Number>().DoubleValue();
  auto mods = static_cast<ghostty_input_mods_e>(
    info[3].As<Napi::Number>().Int32Value()
  );

  GhosttyBridge::instance().mousePos(surfaceId, x, y, mods);
}

// ---------------------------------------------------------------------------
// ghosttyMouseScroll(surfaceId, dx, dy, mods) → void
// ---------------------------------------------------------------------------
void GhosttyMouseScroll(const Napi::CallbackInfo& info) {
  if (info.Length() < 4) return;

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  double dx = info[1].As<Napi::Number>().DoubleValue();
  double dy = info[2].As<Napi::Number>().DoubleValue();
  int scrollMods = info[3].As<Napi::Number>().Int32Value();

  GhosttyBridge::instance().mouseScroll(surfaceId, dx, dy, scrollMods);
}

// ---------------------------------------------------------------------------
// ghosttySetFocus(surfaceId: number, focused: boolean) → void
// ---------------------------------------------------------------------------
void GhosttySetFocus(const Napi::CallbackInfo& info) {
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) return;

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  bool focused = info[1].As<Napi::Boolean>().Value();

  GhosttyBridge::instance().setFocus(surfaceId, focused);
}

// ---------------------------------------------------------------------------
// ghosttyDestroySurface(surfaceId: number) → void
// ---------------------------------------------------------------------------
void GhosttyDestroySurface(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) return;

  uint32_t surfaceId = info[0].As<Napi::Number>().Uint32Value();
  GhosttyBridge::instance().destroySurface(surfaceId);
}

// ---------------------------------------------------------------------------
// ghosttyShutdown() → void
// ---------------------------------------------------------------------------
void GhosttyShutdown(const Napi::CallbackInfo& info) {
  (void)info;
  GhosttyBridge::instance().shutdown();
}

// ---------------------------------------------------------------------------
// Module initialization
// ---------------------------------------------------------------------------
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("ghosttyInit",
    Napi::Function::New(env, GhosttyInit));
  exports.Set("ghosttyGetVersion",
    Napi::Function::New(env, GhosttyGetVersion));
  exports.Set("ghosttyCreateSurface",
    Napi::Function::New(env, GhosttyCreateSurface));
  exports.Set("ghosttySetFrame",
    Napi::Function::New(env, GhosttySetFrame));
  exports.Set("ghosttySetSize",
    Napi::Function::New(env, GhosttySetSize));
  exports.Set("ghosttyKeyEvent",
    Napi::Function::New(env, GhosttyKeyEvent));
  exports.Set("ghosttyMouseButton",
    Napi::Function::New(env, GhosttyMouseButton));
  exports.Set("ghosttyMousePos",
    Napi::Function::New(env, GhosttyMousePos));
  exports.Set("ghosttyMouseScroll",
    Napi::Function::New(env, GhosttyMouseScroll));
  exports.Set("ghosttySetFocus",
    Napi::Function::New(env, GhosttySetFocus));
  exports.Set("ghosttyDestroySurface",
    Napi::Function::New(env, GhosttyDestroySurface));
  exports.Set("ghosttyShutdown",
    Napi::Function::New(env, GhosttyShutdown));

  return exports;
}

NODE_API_MODULE(ghostty, Init)
