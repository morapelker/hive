// nsview_host.h — NSView creation and BrowserWindow attachment
//
// Provides utilities for creating NSViews and attaching them to
// Electron BrowserWindows using the native window handle.

#ifndef NSVIEW_HOST_H
#define NSVIEW_HOST_H

#include <cstdint>
#include <cstddef>

#ifdef __OBJC__
@class NSView;
@class NSWindow;
#else
typedef void NSView;
typedef void NSWindow;
#endif

namespace ghostty {

// Rect in screen coordinates (top-left origin, as Electron uses)
struct ViewRect {
  double x;
  double y;
  double width;
  double height;
};

// Extract the NSWindow* from Electron's getNativeWindowHandle() buffer.
// The buffer is a pointer-sized value containing the NSView* of the
// window's content view. We get the NSWindow from that.
NSWindow* windowFromHandle(const void* handleBuffer, size_t bufferLength);

// Create a new NSView with the given frame and add it as a subview
// of the target window's content view. The frame uses top-left origin
// coordinates (matching Electron's coordinate system).
// Returns the created NSView, or nullptr on failure.
NSView* createHostView(NSWindow* window, ViewRect rect);

// Reposition and resize an existing host view. Handles coordinate
// flipping from Electron's top-left origin to AppKit's bottom-left origin.
void setHostViewFrame(NSView* view, ViewRect rect);

// Associate a Ghostty surface ID with a host view. This enables the native
// host view to forward input events directly to the correct surface.
void setHostViewSurfaceId(NSView* view, uint32_t surfaceId);

// Make the given host view the window's first responder.
void focusHostView(NSView* view);

// Remove the host view from its superview and release it.
void destroyHostView(NSView* view);

// Get the current content scale factor for the window (1.0 or 2.0 for Retina)
double getScaleFactor(NSWindow* window);

} // namespace ghostty

#endif // NSVIEW_HOST_H
