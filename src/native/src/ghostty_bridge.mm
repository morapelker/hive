// ghostty_bridge.mm — ObjC++ implementation of the Ghostty bridge
//
// Implements the GhosttyBridge singleton that wraps libghostty's C API.
// Handles runtime initialization, config loading, surface lifecycle,
// and dispatching callbacks from Ghostty back to the bridge.

#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include "ghostty_bridge.h"
#include "nsview_host.h"

namespace ghostty {

namespace {

uint32_t clampPixelSize(double value) {
  const double rounded = std::round(value);
  if (rounded < 1.0) return 1;
  if (rounded > static_cast<double>(UINT32_MAX)) return UINT32_MAX;
  return static_cast<uint32_t>(rounded);
}

double viewScaleFactor(NSView* view) {
  if (!view) return 1.0;
  NSWindow* window = [view window];
  return window ? getScaleFactor(window) : 1.0;
}

} // namespace

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

GhosttyBridge& GhosttyBridge::instance() {
  static GhosttyBridge bridge;
  return bridge;
}

GhosttyBridge::~GhosttyBridge() {
  shutdown();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

bool GhosttyBridge::init() {
  std::lock_guard<std::mutex> lock(mutex_);

  if (initialized_) {
    return true;
  }

  // Initialize the Ghostty runtime
  // ghostty_init takes (argc, argv) but we pass 0/null for embedding
  int result = ghostty_init(0, nullptr);
  if (result != GHOSTTY_SUCCESS) {
    fprintf(stderr, "[ghostty_bridge] ghostty_init failed with code %d\n", result);
    return false;
  }

  // Create and load config from user's default files
  config_ = ghostty_config_new();
  if (!config_) {
    fprintf(stderr, "[ghostty_bridge] ghostty_config_new failed\n");
    return false;
  }

  ghostty_config_load_default_files(config_);
  ghostty_config_finalize(config_);

  // Check for config diagnostics
  uint32_t diagCount = ghostty_config_diagnostics_count(config_);
  for (uint32_t i = 0; i < diagCount; i++) {
    ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(config_, i);
    fprintf(stderr, "[ghostty_bridge] config diagnostic: %s\n",
            diag.message ? diag.message : "(null)");
  }

  // Set up runtime config with our callbacks
  ghostty_runtime_config_s runtimeCfg = {};
  runtimeCfg.userdata = this;
  runtimeCfg.supports_selection_clipboard = false;
  runtimeCfg.wakeup_cb = &GhosttyBridge::wakeupCallback;
  runtimeCfg.action_cb = &GhosttyBridge::actionCallback;
  runtimeCfg.read_clipboard_cb = &GhosttyBridge::readClipboardCallback;
  runtimeCfg.confirm_read_clipboard_cb = &GhosttyBridge::confirmReadClipboardCallback;
  runtimeCfg.write_clipboard_cb = &GhosttyBridge::writeClipboardCallback;
  runtimeCfg.close_surface_cb = &GhosttyBridge::closeSurfaceCallback;

  // Create the Ghostty app
  app_ = ghostty_app_new(&runtimeCfg, config_);
  if (!app_) {
    fprintf(stderr, "[ghostty_bridge] ghostty_app_new failed\n");
    ghostty_config_free(config_);
    config_ = nullptr;
    return false;
  }

  initialized_ = true;
  fprintf(stderr, "[ghostty_bridge] initialized successfully\n");
  return true;
}

bool GhosttyBridge::isInitialized() const {
  return initialized_;
}

void GhosttyBridge::shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);

  if (!initialized_) {
    return;
  }

  // Destroy all surfaces
  for (auto& [id, surface] : surfaces_) {
    if (surface.handle) {
      ghostty_surface_free(surface.handle);
    }
    if (surface.view) {
      destroyHostView(surface.view);
    }
  }
  surfaces_.clear();

  // Free app and config
  if (app_) {
    ghostty_app_free(app_);
    app_ = nullptr;
  }
  if (config_) {
    ghostty_config_free(config_);
    config_ = nullptr;
  }

  initialized_ = false;
  fprintf(stderr, "[ghostty_bridge] shutdown complete\n");
}

// ---------------------------------------------------------------------------
// Surface management
// ---------------------------------------------------------------------------

uint32_t GhosttyBridge::createSurface(
  NSView* view,
  double scaleFactor,
  float fontSize,
  const std::string& cwd,
  const std::string& shell
) {
  std::lock_guard<std::mutex> lock(mutex_);

  if (!initialized_ || !app_) {
    return 0;
  }

  // Build surface config
  ghostty_surface_config_s surfCfg = ghostty_surface_config_new();
  surfCfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
  surfCfg.platform.macos.nsview = (__bridge void*)view;
  surfCfg.scale_factor = scaleFactor;
  if (fontSize > 0.0f) {
    surfCfg.font_size = fontSize;
  }

  if (!cwd.empty()) {
    surfCfg.working_directory = cwd.c_str();
  }
  if (!shell.empty()) {
    surfCfg.command = shell.c_str();
  }

  // Create the Ghostty surface
  ghostty_surface_t surfHandle = ghostty_surface_new(app_, &surfCfg);
  if (!surfHandle) {
    fprintf(stderr, "[ghostty_bridge] ghostty_surface_new failed\n");
    return 0;
  }

  uint32_t id = nextSurfaceId_++;

  Surface surface;
  surface.id = id;
  surface.handle = surfHandle;
  surface.view = view;
  surface.userdata = nullptr;
  surfaces_[id] = surface;

  fprintf(stderr, "[ghostty_bridge] created surface %u\n", id);
  return id;
}

void GhosttyBridge::setFrame(uint32_t surfaceId, double x, double y, double w, double h) {
  ghostty_surface_t handle = nullptr;
  NSView* view = nil;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end()) return;
    handle = it->second.handle;
    view = it->second.view;
  }

  ViewRect rect = { x, y, w, h };
  setHostViewFrame(view, rect);

  // Also update the Ghostty surface size
  if (handle) {
    const double scale = viewScaleFactor(view);
    ghostty_surface_set_content_scale(handle, scale, scale);
    ghostty_surface_set_size(
      handle,
      clampPixelSize(w * scale),
      clampPixelSize(h * scale)
    );
  }
}

void GhosttyBridge::setContentScale(uint32_t surfaceId, double scaleX, double scaleY) {
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
  }

  ghostty_surface_set_content_scale(handle, scaleX, scaleY);
}

void GhosttyBridge::setSize(uint32_t surfaceId, uint32_t width, uint32_t height) {
  ghostty_surface_t handle = nullptr;
  NSView* view = nil;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
    view = it->second.view;
  }

  const double scale = viewScaleFactor(view);
  ghostty_surface_set_content_scale(handle, scale, scale);
  ghostty_surface_set_size(
    handle,
    clampPixelSize(static_cast<double>(width) * scale),
    clampPixelSize(static_cast<double>(height) * scale)
  );
}

bool GhosttyBridge::keyEvent(
  uint32_t surfaceId,
  ghostty_input_action_e action,
  uint32_t keycode,
  ghostty_input_mods_e mods,
  ghostty_input_mods_e consumedMods,
  const std::string& text,
  uint32_t unshiftedCodepoint,
  bool composing
) {
  // Look up the surface handle under the lock, then release BEFORE calling
  // ghostty_surface_key. Key events (e.g. Cmd+V paste) can synchronously
  // trigger callbacks like readClipboardCallback that re-enter the bridge
  // and try to acquire the same mutex — causing a deadlock.
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return false;
    handle = it->second.handle;
  }

  ghostty_input_key_s keyInput = {};
  keyInput.action = action;
  keyInput.mods = mods;
  keyInput.consumed_mods = consumedMods;
  keyInput.keycode = keycode;
  keyInput.text = text.empty() ? nullptr : text.c_str();
  keyInput.unshifted_codepoint = unshiftedCodepoint;
  keyInput.composing = composing;

  return ghostty_surface_key(handle, keyInput);
}

void GhosttyBridge::mouseButton(
  uint32_t surfaceId,
  ghostty_input_mouse_state_e state,
  ghostty_input_mouse_button_e button,
  ghostty_input_mods_e mods
) {
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
  }

  ghostty_surface_mouse_button(handle, state, button, mods);
}

void GhosttyBridge::mousePos(uint32_t surfaceId, double x, double y, ghostty_input_mods_e mods) {
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
  }

  ghostty_surface_mouse_pos(handle, x, y, mods);
}

void GhosttyBridge::mouseScroll(uint32_t surfaceId, double dx, double dy, int scrollMods) {
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
  }

  ghostty_surface_mouse_scroll(
    handle, dx, dy,
    static_cast<ghostty_input_scroll_mods_t>(scrollMods)
  );
}

void GhosttyBridge::setFocus(uint32_t surfaceId, bool focused) {
  NSView* view = nil;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    view = it->second.view;
  }

  // NSResponder focus changes can synchronously trigger become/resign callbacks.
  // Do this outside the bridge mutex to avoid re-entrant deadlocks.
  if (view && [view window]) {
    NSWindow* window = [view window];
    if (focused && [window firstResponder] != view) {
      [window makeFirstResponder:view];
    } else if (!focused && [window firstResponder] == view) {
      [window makeFirstResponder:nil];
    }
  }

  setSurfaceFocus(surfaceId, focused);
}

void GhosttyBridge::setSurfaceFocus(uint32_t surfaceId, bool focused) {
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
  }

  ghostty_surface_set_focus(handle, focused);
}

void GhosttyBridge::requestClose(uint32_t surfaceId) {
  ghostty_surface_t handle = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = surfaces_.find(surfaceId);
    if (it == surfaces_.end() || !it->second.handle) return;
    handle = it->second.handle;
  }

  ghostty_surface_request_close(handle);
}

void GhosttyBridge::destroySurface(uint32_t surfaceId) {
  std::lock_guard<std::mutex> lock(mutex_);

  auto it = surfaces_.find(surfaceId);
  if (it == surfaces_.end()) return;

  if (it->second.handle) {
    ghostty_surface_free(it->second.handle);
  }
  if (it->second.view) {
    destroyHostView(it->second.view);
  }

  surfaces_.erase(it);
  fprintf(stderr, "[ghostty_bridge] destroyed surface %u\n", surfaceId);
}

Surface* GhosttyBridge::getSurface(uint32_t surfaceId) {
  auto it = surfaces_.find(surfaceId);
  if (it == surfaces_.end()) return nullptr;
  return &it->second;
}

void GhosttyBridge::setCallbacks(uint32_t surfaceId, SurfaceCallbacks callbacks) {
  std::lock_guard<std::mutex> lock(mutex_);

  auto it = surfaces_.find(surfaceId);
  if (it == surfaces_.end()) return;

  it->second.callbacks = std::move(callbacks);
}

std::string GhosttyBridge::getVersion() const {
  ghostty_info_s info = ghostty_info();
  if (info.version && info.version_len > 0) {
    return std::string(info.version, info.version_len);
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Runtime callbacks
// ---------------------------------------------------------------------------

void GhosttyBridge::wakeupCallback(void* userdata) {
  // Called by Ghostty when the app needs to process events.
  // In the Electron context, we dispatch to the main thread.
  auto* bridge = static_cast<GhosttyBridge*>(userdata);
  if (bridge && bridge->app_) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (bridge->app_) {
        ghostty_app_tick(bridge->app_);
      }
    });
  }
}

bool GhosttyBridge::actionCallback(
  ghostty_app_t app,
  ghostty_target_s target,
  ghostty_action_s action
) {
  (void)app;
  return GhosttyBridge::instance().handleAction(target, action);
}

bool GhosttyBridge::handleAction(ghostty_target_s target, ghostty_action_s action) {
  switch (action.tag) {
    case GHOSTTY_ACTION_RENDER: {
      // Find the surface and trigger render callback
      if (target.tag == GHOSTTY_TARGET_SURFACE && target.target.surface) {
        for (auto& [id, surface] : surfaces_) {
          if (surface.handle == target.target.surface) {
            // Draw the surface
            ghostty_surface_draw(surface.handle);
            if (surface.callbacks.onRender) {
              surface.callbacks.onRender();
            }
            return true;
          }
        }
      }
      return false;
    }

    case GHOSTTY_ACTION_SET_TITLE: {
      if (target.tag == GHOSTTY_TARGET_SURFACE && target.target.surface) {
        const char* title = action.action.set_title.title;
        for (auto& [id, surface] : surfaces_) {
          if (surface.handle == target.target.surface && surface.callbacks.onTitleChanged) {
            surface.callbacks.onTitleChanged(title ? title : "");
            return true;
          }
        }
      }
      return false;
    }

    case GHOSTTY_ACTION_CELL_SIZE: {
      if (target.tag == GHOSTTY_TARGET_SURFACE && target.target.surface) {
        uint32_t w = action.action.cell_size.width;
        uint32_t h = action.action.cell_size.height;
        for (auto& [id, surface] : surfaces_) {
          if (surface.handle == target.target.surface && surface.callbacks.onCellSize) {
            surface.callbacks.onCellSize(w, h);
            return true;
          }
        }
      }
      return false;
    }

    case GHOSTTY_ACTION_MOUSE_SHAPE: {
      // Update cursor shape
      ghostty_action_mouse_shape_e shape = action.action.mouse_shape;
      switch (shape) {
        case GHOSTTY_MOUSE_SHAPE_TEXT:
          [[NSCursor IBeamCursor] set];
          break;
        case GHOSTTY_MOUSE_SHAPE_POINTER:
          [[NSCursor pointingHandCursor] set];
          break;
        case GHOSTTY_MOUSE_SHAPE_DEFAULT:
        default:
          [[NSCursor arrowCursor] set];
          break;
      }
      return true;
    }

    case GHOSTTY_ACTION_RING_BELL: {
      NSBeep();
      // Also notify via callback
      if (target.tag == GHOSTTY_TARGET_SURFACE && target.target.surface) {
        for (auto& [id, surface] : surfaces_) {
          if (surface.handle == target.target.surface && surface.callbacks.onBell) {
            surface.callbacks.onBell();
            return true;
          }
        }
      }
      return true;
    }

    case GHOSTTY_ACTION_CLOSE_WINDOW: {
      if (target.tag == GHOSTTY_TARGET_SURFACE && target.target.surface) {
        for (auto& [id, surface] : surfaces_) {
          if (surface.handle == target.target.surface && surface.callbacks.onCloseRequested) {
            surface.callbacks.onCloseRequested();
            return true;
          }
        }
      }
      return false;
    }

    case GHOSTTY_ACTION_PWD: {
      if (target.tag == GHOSTTY_TARGET_SURFACE && target.target.surface) {
        const char* pwd = action.action.pwd.pwd;
        for (auto& [id, surface] : surfaces_) {
          if (surface.handle == target.target.surface && surface.callbacks.onPwdChanged) {
            surface.callbacks.onPwdChanged(pwd ? pwd : "");
            return true;
          }
        }
      }
      return false;
    }

    case GHOSTTY_ACTION_OPEN_URL: {
      const char* url = action.action.open_url.url;
      if (url) {
        NSString* urlStr = [NSString stringWithUTF8String:url];
        NSURL* nsUrl = [NSURL URLWithString:urlStr];
        if (nsUrl) {
          [[NSWorkspace sharedWorkspace] openURL:nsUrl];
        }
      }
      return true;
    }

    case GHOSTTY_ACTION_COLOR_CHANGE:
      // Acknowledge but don't handle specifically
      return true;

    case GHOSTTY_ACTION_SCROLLBAR:
      // Acknowledge scrollbar updates
      return true;

    default:
      // Return false for unhandled actions
      return false;
  }
}

void GhosttyBridge::readClipboardCallback(
  void* userdata,
  ghostty_clipboard_e clipboard,
  void* ctx
) {
  (void)userdata;
  (void)clipboard;

  // Read from the system pasteboard
  auto& bridge = GhosttyBridge::instance();

  NSPasteboard* pb = [NSPasteboard generalPasteboard];
  NSString* content = [pb stringForType:NSPasteboardTypeString];
  const char* utf8 = content ? [content UTF8String] : "";

  // Find the surface that this clipboard request belongs to.
  // The ctx pointer is an opaque token from Ghostty that we pass back
  // to complete_clipboard_request to correlate the response.
  // We need to find which surface initiated the request — iterate all
  // surfaces and complete on the first one that has a valid handle.
  // In practice, only the focused surface will be requesting clipboard.
  //
  // IMPORTANT: We must release the mutex BEFORE calling
  // ghostty_surface_complete_clipboard_request, because completing
  // the request can synchronously trigger Ghostty callbacks (render,
  // title change, wakeup) that re-enter the bridge and try to acquire
  // the same mutex — causing a deadlock that freezes the entire app.
  ghostty_surface_t targetHandle = nullptr;
  {
    std::lock_guard<std::mutex> lock(bridge.mutex_);
    for (auto& [id, surface] : bridge.surfaces_) {
      if (surface.handle) {
        targetHandle = surface.handle;
        break;
      }
    }
  }

  if (targetHandle) {
    ghostty_surface_complete_clipboard_request(
      targetHandle,
      utf8,
      ctx,
      true  // confirmed — auto-confirm in embedded context
    );
  }
}

void GhosttyBridge::confirmReadClipboardCallback(
  void* userdata,
  const char* content,
  void* ctx,
  ghostty_clipboard_request_e request
) {
  (void)userdata;
  (void)request;

  // In the embedded Electron context, we auto-confirm all clipboard reads.
  // The content has already been read; just complete the request.
  //
  // Same mutex-release pattern as readClipboardCallback — find the target
  // surface under the lock, then release before completing the request
  // to avoid re-entrant deadlocks from Ghostty's synchronous callbacks.
  auto& bridge = GhosttyBridge::instance();

  ghostty_surface_t targetHandle = nullptr;
  {
    std::lock_guard<std::mutex> lock(bridge.mutex_);
    for (auto& [id, surface] : bridge.surfaces_) {
      if (surface.handle) {
        targetHandle = surface.handle;
        break;
      }
    }
  }

  if (targetHandle) {
    ghostty_surface_complete_clipboard_request(
      targetHandle,
      content,
      ctx,
      true  // confirmed
    );
  }
}

void GhosttyBridge::writeClipboardCallback(
  void* userdata,
  ghostty_clipboard_e clipboard,
  const ghostty_clipboard_content_s* content,
  size_t count,
  bool confirm
) {
  (void)userdata;
  (void)clipboard;
  (void)confirm;

  if (count > 0 && content && content[0].data) {
    NSPasteboard* pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    NSString* str = [NSString stringWithUTF8String:content[0].data];
    if (str) {
      [pb setString:str forType:NSPasteboardTypeString];
    }
  }
}

void GhosttyBridge::closeSurfaceCallback(void* userdata, bool processRunning) {
  (void)userdata;
  (void)processRunning;
  // Surface close requested from within Ghostty (e.g. shell exited).
  // The JS layer will handle cleanup via the onCloseRequested callback.
}

} // namespace ghostty
