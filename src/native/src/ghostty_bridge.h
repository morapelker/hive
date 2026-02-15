// ghostty_bridge.h — C++ wrapper around the Ghostty C embedding API
//
// Manages the Ghostty app lifecycle (init, config, app creation) and
// provides a surface management API for creating/destroying terminal
// surfaces attached to NSViews.

#ifndef GHOSTTY_BRIDGE_H
#define GHOSTTY_BRIDGE_H

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include "ghostty.h"

// Forward declaration for NSView*
#ifdef __OBJC__
@class NSView;
#else
typedef void NSView;
#endif

namespace ghostty {

// Callbacks from Ghostty surfaces to the JS layer
struct SurfaceCallbacks {
  std::function<void(const std::string&)> onTitleChanged;
  std::function<void(const std::string&)> onPwdChanged;
  std::function<void()> onBell;
  std::function<void(uint32_t, uint32_t)> onCellSize;
  std::function<void()> onCloseRequested;
  std::function<void(const std::string&)> onOpenUrl;
  std::function<void()> onRender;
};

// Manages a single Ghostty terminal surface
struct Surface {
  uint32_t id;
  ghostty_surface_t handle;
  NSView* view;
  SurfaceCallbacks callbacks;
  void* userdata;
};

// Singleton bridge managing the Ghostty runtime
class GhosttyBridge {
public:
  static GhosttyBridge& instance();

  // Initialize the Ghostty runtime. Must be called once before any other
  // operations. Returns true on success, false if already initialized or
  // if ghostty_init() fails.
  bool init();

  // Check if the runtime has been initialized
  bool isInitialized() const;

  // Shut down the Ghostty runtime, destroying all surfaces and freeing
  // the app. After this, init() can be called again.
  void shutdown();

  // Create a new terminal surface. The NSView must already exist and be
  // attached to a window. Returns a surface ID > 0 on success, 0 on failure.
  // fontSize <= 0 means "use Ghostty config default".
  uint32_t createSurface(
    NSView* view,
    double scaleFactor,
    float fontSize,
    const std::string& cwd,
    const std::string& shell
  );

  // Reposition/resize the native view frame
  void setFrame(uint32_t surfaceId, double x, double y, double w, double h);

  // Notify the surface of content scale changes (e.g. Retina displays)
  void setContentScale(uint32_t surfaceId, double scaleX, double scaleY);

  // Set surface size in pixels
  void setSize(uint32_t surfaceId, uint32_t width, uint32_t height);

  // Forward a keyboard event to the surface. Returns true if consumed.
  bool keyEvent(
    uint32_t surfaceId,
    ghostty_input_action_e action,
    uint32_t keycode,
    ghostty_input_mods_e mods,
    ghostty_input_mods_e consumedMods,
    const std::string& text,
    uint32_t unshiftedCodepoint,
    bool composing
  );

  // Forward mouse events
  void mouseButton(
    uint32_t surfaceId,
    ghostty_input_mouse_state_e state,
    ghostty_input_mouse_button_e button,
    ghostty_input_mods_e mods
  );

  void mousePos(uint32_t surfaceId, double x, double y, ghostty_input_mods_e mods);

  void mouseScroll(uint32_t surfaceId, double dx, double dy, int scrollMods);

  // Focus management
  void setFocus(uint32_t surfaceId, bool focused);

  // Update libghostty focus state only (no NSResponder changes).
  void setSurfaceFocus(uint32_t surfaceId, bool focused);

  // Request surface close (graceful)
  void requestClose(uint32_t surfaceId);

  // Destroy a surface immediately
  void destroySurface(uint32_t surfaceId);

  // Get surface by ID (returns nullptr if not found)
  Surface* getSurface(uint32_t surfaceId);

  // Set callbacks for a surface
  void setCallbacks(uint32_t surfaceId, SurfaceCallbacks callbacks);

  // Get version info
  std::string getVersion() const;

private:
  GhosttyBridge() = default;
  ~GhosttyBridge();

  GhosttyBridge(const GhosttyBridge&) = delete;
  GhosttyBridge& operator=(const GhosttyBridge&) = delete;

  // Runtime callbacks (static, dispatched to instance)
  static void wakeupCallback(void* userdata);
  static bool actionCallback(ghostty_app_t app, ghostty_target_s target, ghostty_action_s action);
  static void readClipboardCallback(void* userdata, ghostty_clipboard_e clipboard, void* ctx);
  static void confirmReadClipboardCallback(
    void* userdata,
    const char* content,
    void* ctx,
    ghostty_clipboard_request_e request
  );
  static void writeClipboardCallback(
    void* userdata,
    ghostty_clipboard_e clipboard,
    const ghostty_clipboard_content_s* content,
    size_t count,
    bool confirm
  );
  static void closeSurfaceCallback(void* userdata, bool processRunning);

  // Handle an action from the Ghostty runtime
  bool handleAction(ghostty_target_s target, ghostty_action_s action);

  bool initialized_ = false;
  ghostty_app_t app_ = nullptr;
  ghostty_config_t config_ = nullptr;
  std::unordered_map<uint32_t, Surface> surfaces_;
  std::mutex mutex_;
  uint32_t nextSurfaceId_ = 1;
};

} // namespace ghostty

#endif // GHOSTTY_BRIDGE_H
